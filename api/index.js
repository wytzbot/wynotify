import crypto from "node:crypto";
import admin from "firebase-admin";

export const config = { api: { bodyParser: false } };

const PROD_API = "https://api.flutterwave.com";
const SANDBOX_API = "https://developersandbox-api.flutterwave.com";
const TOKEN_URL = "https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token";
const PLANS = {
  free: { subscribers: 1000, analyticsDays: 7 },
  starter: { subscribers: 5000, analyticsDays: 30 },
  pro: { subscribers: 25000, analyticsDays: 90 },
  business: { subscribers: 100000, analyticsDays: 365 }
};
const PLAN_PRICES = { starter: 5000, pro: 12000, business: 25000 };

function getAdmin() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not configured on the server.");
  const service = typeof raw === "string" ? JSON.parse(raw) : raw;
  return admin.initializeApp({ credential: admin.credential.cert(service) });
}
function db() { return getAdmin().firestore(); }
function id(prefix = "wy") { return `${prefix}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`; }
function json(res, status, data) { res.status(status).setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data)); }

async function rawBody(req) {
  if (req.__rawBody !== undefined) return req.__rawBody;
  if (typeof req.body === "string") return (req.__rawBody = req.body);
  if (req.body && typeof req.body === "object") return (req.__rawBody = JSON.stringify(req.body));
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return (req.__rawBody = Buffer.concat(chunks).toString("utf8"));
}
async function bodyOf(req) {
  if (req.__parsedBody !== undefined) return req.__parsedBody;
  const raw = await rawBody(req);
  if (!raw.trim()) return (req.__parsedBody = {});
  try { return (req.__parsedBody = JSON.parse(raw)); }
  catch { const e = new Error("Request body must be valid JSON."); e.status = 400; throw e; }
}
function setCors(res, publicEndpoint = false) {
  if (publicEndpoint) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  }
}

async function getToken() {
  if (!process.env.FLW_CLIENT_ID || !process.env.FLW_CLIENT_SECRET) throw new Error("Flutterwave v4 credentials are not configured on the server.");
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.FLW_CLIENT_ID, client_secret: process.env.FLW_CLIENT_SECRET, grant_type: "client_credentials" })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) throw new Error(data.error_description || data.message || "Unable to authenticate with Flutterwave.");
  return data.access_token;
}
async function flw(path, options = {}) {
  const token = await getToken();
  const base = process.env.FLW_SANDBOX === "true" ? SANDBOX_API : PROD_API;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json", "X-Trace-Id": id("trace"), ...(options.headers || {}) };
  const r = await fetch(base + path, { ...options, headers });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const msg = data?.error?.message || data?.message || `Flutterwave request failed (${r.status})`; const e = new Error(msg); e.status = r.status; e.details = data; throw e; }
  return data;
}
async function requireUser(req) {
  const auth = String(req.headers.authorization || "");
  if (!auth.startsWith("Bearer ")) { const e = new Error("Authentication required."); e.status = 401; throw e; }
  try { return await getAdmin().auth().verifyIdToken(auth.slice(7)); }
  catch { const e = new Error("Invalid or expired authentication token."); e.status = 401; throw e; }
}

async function ensureWorkspace(uid) {
  const ref = db().collection("users").doc(uid);
  const snap = await ref.get();
  const data = snap.exists ? snap.data() : {};
  if (data.workspace?.id && data.workspace?.publicKey) return data.workspace;
  const workspace = {
    id: data.workspace?.id || id("ws"),
    publicKey: data.workspace?.publicKey || crypto.randomBytes(24).toString("base64url"),
    name: data.workspace?.name || "My Workspace",
    createdAt: data.workspace?.createdAt || admin.firestore.Timestamp.now()
  };
  await ref.set({ workspace, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  return workspace;
}

function subscriptionInfo(data) {
  const sub = data?.subscription || {};
  const expiry = sub.expiresAt?.toDate?.() || new Date(0);
  const active = sub.status === "active" && expiry > new Date();
  return { plan: active ? String(sub.plan || "free") : "free", active, expiresAt: active ? expiry.toISOString() : null };
}

async function upsertSubscription(uid, plan, reference, charge) {
  if (!PLANS[plan] || plan === "free") throw new Error("Invalid paid plan.");
  const userRef = db().collection("users").doc(uid);
  const paymentRef = db().collection("payments").doc(reference);
  return db().runTransaction(async t => {
    const [userSnap, paymentSnap] = await Promise.all([t.get(userRef), t.get(paymentRef)]);
    const payment = paymentSnap.exists ? paymentSnap.data() : {};
    if (payment.status === "succeeded" && payment.subscriptionApplied === true) return { applied: false, alreadyApplied: true };
    const old = userSnap.exists ? userSnap.data() : {};
    const existing = old.subscription || {};
    const currentExpiry = existing.expiresAt?.toDate?.() || new Date(0);
    const base = currentExpiry > new Date() ? currentExpiry : new Date();
    const next = new Date(base); next.setMonth(next.getMonth() + 1);
    t.set(userRef, {
      subscription: { plan, status: "active", reference, chargeId: charge?.id || null, startedAt: admin.firestore.FieldValue.serverTimestamp(), expiresAt: admin.firestore.Timestamp.fromDate(next) },
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    t.set(paymentRef, { uid, plan, reference, chargeId: charge?.id || null, status: "succeeded", amount: charge?.amount ?? payment.amount ?? null, currency: charge?.currency ?? payment.currency ?? null, subscriptionApplied: true, verifiedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return { applied: true, alreadyApplied: false };
  });
}

async function workspaceForUser(uid) {
  const userRef = db().collection("users").doc(uid);
  const snap = await userRef.get();
  return ensureWorkspace(uid).then(workspace => ({ workspace, user: snap.exists ? snap.data() : {} }));
}

async function getWorkspaceByPublicKey(key) {
  if (!key) return null;
  const snap = await db().collection("users").where("workspace.publicKey", "==", String(key)).limit(1).get();
  if (snap.empty) return null;
  return { uid: snap.docs[0].id, workspace: snap.docs[0].data().workspace || {} };
}

async function activeDevices(workspaceId) {
  const snap = await db().collection("devices").where("workspaceId", "==", workspaceId).get();
  return snap.docs.filter(x => x.data().active !== false).map(x => ({ id: x.id, ...x.data() }));
}
async function rateLimitPublicRegistration(workspaceId, req) {
  const ip = String(req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || "unknown").split(",")[0].trim();
  const minute = Math.floor(Date.now() / 60000);
  const key = crypto.createHash("sha256").update(`${workspaceId}:${ip}:${minute}`).digest("hex");
  const ref = db().collection("rateLimits").doc(key);
  const result = await db().runTransaction(async t => {
    const snap = await t.get(ref); const count = snap.exists ? Number(snap.data().count || 0) : 0;
    if (count >= 30) return false;
    t.set(ref, { count: count + 1, workspaceId, minute, createdAt: snap.exists ? snap.data().createdAt : admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return true;
  });
  return result;
}

export default async function handler(req, res) {
  try {
    const action = req.query?.action || (req.method !== "GET" ? (await bodyOf(req)).action : undefined);
    if (req.method === "OPTIONS") { setCors(res, action === "registerDevice"); res.status(204).end(); return; }
    if (req.method === "GET" && action === "health") return json(res, 200, { ok: true, service: "WyNotify API", version: 4, flutterwaveV4: true });

    if (req.method === "POST" && action === "registerDevice") {
      setCors(res, true);
      const b = await bodyOf(req);
      if (!b.token || typeof b.token !== "string" || b.token.length < 20) return json(res, 400, { error: "A valid FCM token is required." });
      let workspaceId = "";
      let ownerUid = null;
      if (req.headers.authorization) {
        const user = await requireUser(req);
        const { workspace } = await workspaceForUser(user.uid);
        ownerUid = user.uid;
        workspaceId = workspace.id;
      } else if (b.workspaceKey) {
        const found = await getWorkspaceByPublicKey(b.workspaceKey);
        if (!found) return json(res, 404, { error: "Workspace registration key is invalid or expired." });
        workspaceId = found.workspace.id;
        ownerUid = found.uid;
      }
      if (!workspaceId) return json(res, 400, { error: "workspaceKey or authenticated workspace is required." });
      if (!req.headers.authorization && !(await rateLimitPublicRegistration(workspaceId, req))) return json(res, 429, { error: "Too many registration attempts. Please try again in a minute." });
      const owner = await db().collection("users").where("workspace.id", "==", workspaceId).limit(1).get();
      const ownerDoc = owner.empty ? null : owner.docs[0];
      if (!ownerDoc || (ownerUid && ownerDoc.id !== ownerUid)) return json(res, 404, { error: "Workspace not found." });
      const ownerData = ownerDoc.data();
      const plan = subscriptionInfo(ownerData).plan;
      const limit = PLANS[plan]?.subscribers || PLANS.free.subscribers;
      const devices = await activeDevices(workspaceId);
      const tokenHash = crypto.createHash("sha256").update(b.token).digest("hex");
      const existing = await db().collection("devices").doc(tokenHash).get();
      if (!existing.exists && devices.length >= limit) return json(res, 409, { error: `This workspace has reached its ${plan} plan limit of ${limit.toLocaleString()} subscribers.` });
      await db().collection("devices").doc(tokenHash).set({ workspaceId, ownerUid: ownerDoc.id, token: b.token, type: "web", subscriberType: String(b.subscriberType || "all").slice(0, 80), tags: Array.isArray(b.tags) ? b.tags.slice(0, 50).map(x => String(x).slice(0, 50)) : [], active: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return json(res, 200, { ok: true, workspaceId, registered: true });
    }

    if (req.method === "POST" && action === "opay") {
      const user = await requireUser(req); const b = await bodyOf(req); const plan = String(b.plan || "").toLowerCase();
      if (!PLAN_PRICES[plan]) return json(res, 400, { error: "Choose a valid paid plan." });
      const amount = PLAN_PRICES[plan];
      if (!b.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.email))) return json(res, 400, { error: "A valid billing email is required." });
      const reference = id("wynotify"); const appUrl = process.env.APP_URL || `https://${req.headers.host}`;
      const first = (String(b.name || "WyNotify customer").trim().split(/\s+/)[0] || "WyNotify");
      const rest = String(b.name || "").trim().split(/\s+/).slice(1).join(" ");
      const data = await flw("/orchestration/direct-charges", { method: "POST", headers: { "X-Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ amount, currency: "NGN", reference, redirect_url: `${appUrl}/?billing=1&reference=${encodeURIComponent(reference)}`, payment_method: { type: "opay" }, customer: { email: String(b.email), name: { first, last: rest }, ...(b.phone ? { phone: { country_code: "234", number: String(b.phone).replace(/^0+/, "") } } : {}) }, meta: { uid: user.uid, plan } }) });
      const chargeId = data?.data?.id || data?.id || null;
      await db().collection("payments").doc(reference).set({ uid: user.uid, plan, reference, chargeId, amount, currency: "NGN", status: "pending", createdAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return json(res, 200, { ok: true, reference, chargeId, data });
    }

    if (req.method === "GET" && action === "verifyPayment") {
      const user = await requireUser(req); const reference = String(req.query.reference || ""); if (!reference) return json(res, 400, { error: "Payment reference is required." });
      const paymentSnap = await db().collection("payments").doc(reference).get(); const payment = paymentSnap.exists ? paymentSnap.data() : null;
      if (!payment || payment.uid !== user.uid) return json(res, 404, { error: "Payment not found." });
      if (payment.status === "succeeded" && payment.subscriptionApplied) return json(res, 200, { ok: true, status: "succeeded", plan: payment.plan, alreadyApplied: true });
      let data = payment.chargeId ? await flw(`/charges/${encodeURIComponent(payment.chargeId)}`, { method: "GET" }) : await flw(`/charges?reference=${encodeURIComponent(reference)}&size=10`, { method: "GET" });
      const charge = data?.data?.status ? data.data : (Array.isArray(data?.data) ? data.data[0] : data?.data?.data?.[0]);
      if (!charge) return json(res, 200, { ok: true, status: "pending" });
      if (charge.reference !== reference || Number(charge.amount) !== Number(payment.amount) || String(charge.currency) !== String(payment.currency)) return json(res, 409, { error: "Payment details do not match the pending order." });
      if (charge.status === "succeeded") { const result = await upsertSubscription(user.uid, payment.plan, reference, charge); return json(res, 200, { ok: true, status: "succeeded", plan: payment.plan, alreadyApplied: !result.applied }); }
      if (["failed", "voided"].includes(charge.status)) await db().collection("payments").doc(reference).set({ status: charge.status, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return json(res, 200, { ok: true, status: charge.status || "pending" });
    }

    if (req.method === "POST" && action === "send") {
      const user = await requireUser(req); const b = await bodyOf(req); const title = String(b.title || "").trim(), message = String(b.message || "").trim();
      if (!title || !message) return json(res, 400, { error: "Title and message are required." });
      if (title.length > 120 || message.length > 1000) return json(res, 400, { error: "Title must be 120 characters or less and message 1,000 characters or less." });
      const { workspace, user: userData } = await workspaceForUser(user.uid); const sub = subscriptionInfo(userData); const limit = PLANS[sub.plan]?.subscribers || 1000;
      const devices = await activeDevices(workspace.id); let matches = devices;
      const audience = String(b.audience || "all"); if (audience !== "all") matches = matches.filter(d => d.subscriberType === audience || d.tags?.includes(audience));
      if (devices.length > limit) return json(res, 409, { error: `Your workspace exceeds the ${sub.plan} subscriber limit. Upgrade your plan or remove inactive subscribers.` });
      const deliverable = matches.filter(d => typeof d.token === "string" && d.token).slice(0, 500);
      const tokens = deliverable.map(d => d.token);
      if (!tokens.length) return json(res, 400, { error: "No active subscribers match this audience. Register a customer device first." });
      const notificationId = id("notification");
      const result = await getAdmin().messaging().sendEachForMulticast({ tokens, notification: { title, body: message }, data: { url: String(b.url || "/"), notificationId } });
      await db().collection("notifications").doc(notificationId).set({ uid: user.uid, workspaceId: workspace.id, title, message, audience, count: tokens.length, successCount: result.successCount, failureCount: result.failureCount, status: result.successCount ? "sent" : "failed", createdAt: admin.firestore.FieldValue.serverTimestamp() });
      const invalid = []; result.responses.forEach((r, i) => { if (!r.success && ["messaging/registration-token-not-registered", "messaging/invalid-registration-token"].includes(r.error?.code)) invalid.push(deliverable[i].id); });
      if (invalid.length) await Promise.all(invalid.map(x => db().collection("devices").doc(x).set({ active: false, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true })));
      return json(res, 200, { ok: true, notificationId, matched: tokens.length, sent: result.successCount, failed: result.failureCount });
    }

    if (req.method === "GET" && action === "dashboard") {
      const user = await requireUser(req); const { workspace, user: userData } = await workspaceForUser(user.uid); const [n, d] = await Promise.all([db().collection("notifications").where("workspaceId", "==", workspace.id).orderBy("createdAt", "desc").limit(100).get(), db().collection("devices").where("workspaceId", "==", workspace.id).get()]);
      const active = d.docs.filter(x => x.data().active !== false); const sub = subscriptionInfo(userData);
      const recent = n.docs.map(x => ({ id: x.id, ...x.data(), createdAt: x.data().createdAt?.toDate?.()?.toISOString() || null })).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
      return json(res, 200, { ok: true, workspace, subscription: { ...userData?.subscription, plan: sub.plan, active: sub.active, expiresAt: sub.expiresAt }, subscribers: active.length, notifications: n.size, recent, registration: { workspaceKey: workspace.publicKey, endpoint: "/api?action=registerDevice" } });
    }

    if (req.method === "POST" && action === "webhook") {
      const secret = process.env.FLW_SECRET_HASH; if (!secret) return json(res, 500, { error: "FLW_SECRET_HASH is not configured." });
      const raw = await rawBody(req); const signature = String(req.headers["flutterwave-signature"] || ""); const direct = String(req.headers["verif-hash"] || ""); const expected = crypto.createHmac("sha256", secret).update(raw).digest("base64");
      const safeEqual = signature && Buffer.byteLength(signature) === Buffer.byteLength(expected) && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
      if (!safeEqual && direct !== secret) return json(res, 401, { error: "Invalid webhook signature." });
      let payload; try { payload = JSON.parse(raw); } catch { return json(res, 400, { error: "Invalid webhook JSON." }); }
      const eventId = String(payload?.id || `raw-${crypto.createHash("sha256").update(raw).digest("hex")}`);
      const eventRef = db().collection("webhookEvents").doc(eventId); const existingEvent = await eventRef.get();
      if (existingEvent.exists && existingEvent.data()?.processed === true) return json(res, 200, { received: true, eventId, duplicate: true });
      const chargeId = payload?.data?.id || payload?.data?.charge_id; let charge = null;
      if (chargeId) { try { const r = await flw(`/charges/${encodeURIComponent(chargeId)}`, { method: "GET" }); charge = r?.data || null; } catch (e) { console.error("webhook charge verification", e.message); } }
      if (charge?.reference) { const ps = await db().collection("payments").doc(charge.reference).get(); if (ps.exists) { const p = ps.data(); if (p.uid && charge.status === "succeeded" && Number(charge.amount) === Number(p.amount) && String(charge.currency) === String(p.currency)) await upsertSubscription(p.uid, p.plan, charge.reference, charge); else await db().collection("payments").doc(charge.reference).set({ status: charge.status || "pending", lastWebhookEvent: eventId, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }); } }
      await eventRef.set({ eventId, type: payload?.type || null, processed: true, receivedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return json(res, 200, { received: true, eventId, type: payload?.type || null });
    }

    return json(res, 404, { error: "Route not found." });
  } catch (e) {
    console.error("WyNotify API error", e);
    return json(res, e.status || 500, { error: e.message || "Internal server error." });
  }
}
