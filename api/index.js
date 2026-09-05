import crypto from "node:crypto";
import { createRequire } from "node:module";
import admin from "firebase-admin";
import webpush from "web-push";

export const config = { api: { bodyParser: false } };

// package.json is the single source of truth for the app version (see
// vite.config.js and scripts/generate-sw.mjs). Reading it here with
// createRequire (rather than a hand-copied literal) means the health check
// can never drift out of step with the version the frontend actually shipped.
const APP_VERSION = createRequire(import.meta.url)("../package.json").version;

const PROD_API = "https://api.flutterwave.com";
const SANDBOX_API = "https://developersandbox-api.flutterwave.com";
const TOKEN_URL = "https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token";
const PLANS = {
  // Billing is based on notification campaigns, not subscriber count.
  // A campaign counts once even if it is delivered to many opted-in devices.
  free: { notifications: 100, analyticsDays: 7 },
  starter: { notifications: 1000, analyticsDays: 30 },
  pro: { notifications: 5000, analyticsDays: 90 },
  business: { notifications: 20000, analyticsDays: 365 }
};
// Priced in NGN, kept in step with the USD reference shown on the pricing page.
// Fixed NGN checkout equivalents shown by the pricing page: $5 = ₦7,500, $10 = ₦15,000, $15 = ₦22,500.
const PLAN_PRICES = { starter: 7500, pro: 15000, business: 22500 };
const PLAN_FEATURES = {
  free: { scheduling: false, clickTracking: true, rss: false, automation: false, abTesting: false, smartTiming: false, frequency: false, segments: false, inbox: true, api: false },
  starter: { scheduling: false, clickTracking: true, rss: true, automation: false, abTesting: false, smartTiming: false, frequency: true, segments: true, inbox: true, api: false },
  pro: { scheduling: true, clickTracking: true, rss: true, automation: true, abTesting: true, smartTiming: false, frequency: true, segments: true, inbox: true, api: true },
  business: { scheduling: true, clickTracking: true, rss: true, automation: true, abTesting: true, smartTiming: true, frequency: true, segments: true, inbox: true, api: true }
};
function webPushReady() {
  return Boolean(process.env.WEB_PUSH_PUBLIC_KEY && process.env.WEB_PUSH_PRIVATE_KEY && process.env.WEB_PUSH_SUBJECT);
}
function configureWebPush() {
  if (!webPushReady()) throw new Error("Web Push is not configured. Add WEB_PUSH_PUBLIC_KEY, WEB_PUSH_PRIVATE_KEY and WEB_PUSH_SUBJECT to the server environment.");
  webpush.setVapidDetails(process.env.WEB_PUSH_SUBJECT, process.env.WEB_PUSH_PUBLIC_KEY, process.env.WEB_PUSH_PRIVATE_KEY);
}

function getAdmin() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not configured on the server.");
  const service = typeof raw === "string" ? JSON.parse(raw) : raw;
  return admin.initializeApp({ credential: admin.credential.cert(service) });
}
function db() { return getAdmin().firestore(); }
function id(prefix = "wy") { return `${prefix}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`; }
function json(res, status, data) { res.status(status).setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0"); res.setHeader("Pragma", "no-cache"); res.setHeader("Expires", "0"); res.end(JSON.stringify(data)); }

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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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

async function workspaceForApiKey(apiKey) {
  const key = String(apiKey || '').trim();
  if (!/^wy_live_[A-Za-z0-9_-]{24,}$/.test(key)) return null;
  const hash = crypto.createHash("sha256").update(key).digest("hex");
  const snap = await db().collection("users").where("workspace.apiKeyHash", "==", hash).limit(1).get();
  if (snap.empty) return null;
  const data = snap.docs[0].data();
  return { uid: snap.docs[0].id, user: data, workspace: data.workspace || {} };
}
async function requireWorkspaceAccess(req) {
  const auth = String(req.headers.authorization || "");
  if (auth.startsWith("Bearer ")) {
    const user = await requireUser(req);
    const { workspace, user: userData } = await workspaceForUser(user.uid);
    return { uid: user.uid, user: userData, workspace, authType: "user" };
  }
  const key = req.headers["x-wynotify-api-key"] || req.headers["x-api-key"] || "";
  const found = await workspaceForApiKey(key);
  if (!found) { const e = new Error("Authentication required. Use a Firebase session or X-WyNotify-API-Key."); e.status = 401; throw e; }
  // The key may have been minted while the workspace was on a plan that
  // includes developer API access; re-check the *current* plan on every call
  // so a downgrade actually revokes programmatic access instead of only
  // hiding the key-generation button in the dashboard.
  const sub = subscriptionInfo(found.user);
  if (!(PLAN_FEATURES[sub.plan] || PLAN_FEATURES.free).api) { const e = new Error("Developer API access requires Pro or Business. Upgrade your plan to keep using this API key."); e.status = 402; throw e; }
  return { ...found, authType: "apiKey" };
}
function newApiKey() { return `wy_live_${crypto.randomBytes(32).toString("base64url")}`; }
function apiKeyHash(key) { return crypto.createHash("sha256").update(String(key)).digest("hex"); }

async function ensureWorkspace(uid) {
  const ref = db().collection("users").doc(uid);
  const snap = await ref.get();
  const data = snap.exists ? snap.data() : {};
  if (data.workspace?.id && data.workspace?.publicKey) return data.workspace;
  const workspace = {
    id: data.workspace?.id || id("ws"),
    publicKey: data.workspace?.publicKey || crypto.randomBytes(24).toString("base64url"),
    name: data.workspace?.name || "My Workspace",
    createdAt: data.workspace?.createdAt || admin.firestore.Timestamp.now(),
    apiKeyHash: data.workspace?.apiKeyHash || null,
    apiKeyLast4: data.workspace?.apiKeyLast4 || null
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

async function findWorkspaceByPublicKey(publicKey) {
  if (!publicKey) return null;
  const snap = await db().collection("users").where("workspace.publicKey", "==", publicKey).limit(1).get();
  if (snap.empty) return null;
  const d = snap.docs[0].data();
  return d.workspace || null;
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

function usagePeriod(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function notificationUsage(workspaceId) {
  const ref = db().collection("notificationUsage").doc(workspaceId);
  const snap = await ref.get();
  const period = usagePeriod();
  if (!snap.exists || snap.data()?.period !== period) return { period, count: 0 };
  return { period, count: Number(snap.data()?.count || 0) };
}

async function reserveNotificationSlot(workspaceId, plan) {
  const limit = PLANS[plan]?.notifications || PLANS.free.notifications;
  const ref = db().collection("notificationUsage").doc(workspaceId);
  const period = usagePeriod();
  return db().runTransaction(async t => {
    const snap = await t.get(ref);
    const current = snap.exists && snap.data()?.period === period ? Number(snap.data()?.count || 0) : 0;
    if (current >= limit) return { allowed: false, count: current, limit, period };
    const next = current + 1;
    t.set(ref, { workspaceId, period, count: next, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return { allowed: true, count: next, limit, period };
  });
}
async function rateLimit(bucket, req, max = 30) {
  const ip = String(req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || "unknown").split(",")[0].trim();
  const minute = Math.floor(Date.now() / 60000);
  const key = crypto.createHash("sha256").update(`${bucket}:${ip}:${minute}`).digest("hex");
  const ref = db().collection("rateLimits").doc(key);
  const result = await db().runTransaction(async t => {
    const snap = await t.get(ref); const count = snap.exists ? Number(snap.data().count || 0) : 0;
    if (count >= max) return false;
    t.set(ref, { count: count + 1, bucket, minute, createdAt: snap.exists ? snap.data().createdAt : admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return true;
  });
  return result;
}
function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function deliverToDevices({ deliverable, title, message, url, notificationId }) {
  configureWebPush();
  let successCount = 0, failureCount = 0;
  const invalid = [];
  const apiOrigin = String(process.env.APP_URL || "").replace(/\/$/, "");
  const payload = JSON.stringify({
    notification: { title, body: message, url: String(url || "/") },
    data: { url: String(url || "/"), notificationId, clickApi: apiOrigin ? `${apiOrigin}/api?action=trackClick` : "" }
  });
  // Web Push sends one encrypted request per browser subscription. Keep concurrency bounded.
  for (const batch of chunkArray(deliverable, 25)) {
    const results = await Promise.all(batch.map(async (device) => {
      try {
        await webpush.sendNotification(device.subscription, payload, { TTL: 86400, urgency: "normal" });
        return { ok: true };
      } catch (error) {
        return { ok: false, statusCode: Number(error?.statusCode || 0), error };
      }
    }));
    results.forEach((result, i) => {
      if (result.ok) successCount += 1;
      else {
        failureCount += 1;
        if ([404, 410].includes(result.statusCode)) invalid.push(batch[i].id);
      }
    });
  }
  return { tokens: deliverable.map(d => d.id), successCount, failureCount, invalid };
}


async function workspaceSettings(workspaceId) {
  const snap = await db().collection("workspaceSettings").doc(workspaceId).get();
  return snap.exists ? snap.data() : { dailyCap: 3, quietMinutes: 60 };
}
async function devicesMatching(workspaceId, audience = "all", segmentId = "") {
  const devices = await activeDevices(workspaceId);
  if (segmentId) {
    const seg = await db().collection("segments").doc(segmentId).get();
    if (!seg.exists || seg.data().workspaceId !== workspaceId) return [];
    const wanted = new Set((seg.data().tags || []).map(String));
    return devices.filter(d => (d.tags || []).some(t => wanted.has(String(t))));
  }
  if (audience === "all") return devices;
  return devices.filter(d => d.subscriberType === audience || d.tags?.includes(audience));
}
async function checkFrequency(workspaceId, devices, settings) {
  const cap = Math.max(1, Math.min(20, Number(settings.dailyCap || 3)));
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const snap = await db().collection("notifications").where("workspaceId", "==", workspaceId).where("createdAt", ">=", admin.firestore.Timestamp.fromDate(since)).limit(100).get();
  const recent = snap.docs.map(d => d.data());
  const campaignIds = new Set(recent.map((x, i) => String(x.campaignId || x.abTestId || `doc-${i}`)));
  if (campaignIds.size >= cap) return { allowed: false, reason: `Frequency cap reached: ${cap} campaigns in the last 24 hours.` };
  const quiet = Math.max(0, Math.min(1440, Number(settings.quietMinutes || 0)));
  const latest = recent.map(x => x.createdAt?.toDate?.()?.getTime?.() || 0).sort((a,b)=>b-a)[0] || 0;
  if (quiet && latest && Date.now() - latest < quiet * 60000) return { allowed: false, reason: `Quiet period active. Try again in about ${Math.ceil((quiet*60000-(Date.now()-latest))/60000)} minute(s).` };
  return { allowed: true };
}
async function deliverCampaign({uid, workspaceId, plan, title, message, url, audience="all", segmentId="", variant="A", scheduled=false}) {
  const matches = await devicesMatching(workspaceId, audience, segmentId);
  const deliverable = matches.filter(d => d.subscription?.endpoint && d.subscription?.keys?.p256dh && d.subscription?.keys?.auth);
  if (!deliverable.length) return { ok:false, error:"No active subscribers match this audience." };
  const quota = await reserveNotificationSlot(workspaceId, plan);
  if (!quota.allowed) return { ok:false, error:`Monthly notification limit reached (${quota.limit}).`, quotaExceeded:true };
  const notificationId=id("notification");
  const result=await deliverToDevices({deliverable,title,message,url,notificationId});
  await db().collection("notifications").doc(notificationId).set({uid,workspaceId,title,message,audience,segmentId:segmentId||null,variant,count:result.tokens.length,successCount:result.successCount,failureCount:result.failureCount,clicks:0,status:result.successCount?"sent":"failed",scheduled,createdAt:admin.firestore.FieldValue.serverTimestamp()});
  if(result.invalid.length) await Promise.all(result.invalid.map(x=>db().collection("devices").doc(x).set({active:false,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true})));
  return {ok:true,notificationId,matched:result.tokens.length,sent:result.successCount,failed:result.failureCount};
}

export default async function handler(req, res) {
  try {
    const action = req.query?.action || (req.method !== "GET" ? (await bodyOf(req)).action : undefined);
    if (req.method === "OPTIONS") { setCors(res, action === "registerDevice" || action === "trackClick" || action === "publicConfig"); res.status(204).end(); return; }
    if (req.method === "GET" && action === "health") return json(res, 200, { ok: true, service: "WyNotify API", version: APP_VERSION, webPush: true, flutterwaveV4: true });

    // Public Web Push configuration. Only the public push key is exposed.
    if (req.method === "GET" && action === "publicConfig") {
      setCors(res, true);
      const workspaceKey = String(req.query?.workspaceKey || "").trim();
      if (workspaceKey) {
        const workspace = await findWorkspaceByPublicKey(workspaceKey);
        if (!workspace) return json(res, 404, { error: "Invalid workspace key." });
      }
      if (!webPushReady()) return json(res, 500, { error: "WyNotify Web Push is not configured yet. Add your Web Push VAPID keys in the server environment." });
      return json(res, 200, { ok: true, workspaceKey: workspaceKey || null, publicKey: process.env.WEB_PUSH_PUBLIC_KEY });
    }

    if (req.method === "POST" && action === "registerDevice") {
      setCors(res, true);
      const b = await bodyOf(req);
      const subscription = b.subscription;
      if (!subscription || typeof subscription !== "object" || typeof subscription.endpoint !== "string" || !subscription.endpoint.startsWith("https://") || !subscription.keys?.p256dh || !subscription.keys?.auth) {
        return json(res, 400, { error: "A valid Web Push subscription is required." });
      }
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
      if (!req.headers.authorization && !(await rateLimit(`register:${workspaceId}`, req, 30))) return json(res, 429, { error: "Too many registration attempts. Please try again in a minute." });
      const owner = await db().collection("users").where("workspace.id", "==", workspaceId).limit(1).get();
      const ownerDoc = owner.empty ? null : owner.docs[0];
      if (!ownerDoc || (ownerUid && ownerDoc.id !== ownerUid)) return json(res, 404, { error: "Workspace not found." });
      const ownerData = ownerDoc.data();
      // Subscriber count is not a billing gate. Businesses can build a large opted-in audience;
      // billing is based on notification sends instead.
      const devices = await activeDevices(workspaceId);
      const endpointHash = crypto.createHash("sha256").update(subscription.endpoint).digest("hex");
      const existing = await db().collection("devices").doc(endpointHash).get();
      await db().collection("devices").doc(endpointHash).set({ workspaceId, ownerUid: ownerDoc.id, subscription: { endpoint: subscription.endpoint, keys: { p256dh: String(subscription.keys.p256dh), auth: String(subscription.keys.auth) } }, type: "web", subscriberType: String(b.subscriberType || "all").slice(0, 80), tags: Array.isArray(b.tags) ? b.tags.slice(0, 50).map(x => String(x).slice(0, 50)) : [], active: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
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
      const access = await requireWorkspaceAccess(req); const user = { uid: access.uid }; const b = await bodyOf(req); const title = String(b.title || "").trim(), message = String(b.message || "").trim();
      if (!title || !message) return json(res, 400, { error: "Title and message are required." });
      if (title.length > 120 || message.length > 1000) return json(res, 400, { error: "Title must be 120 characters or less and message 1,000 characters or less." });
      const { workspace, user: userData } = access; const sub = subscriptionInfo(userData); const features=PLAN_FEATURES[sub.plan]||PLAN_FEATURES.free;
      const audience = String(b.audience || "all"); const segmentId=String(b.segmentId||"");
      if(segmentId && !features.segments) return json(res,402,{error:"Segments are available on Starter, Pro and Business."});
      if (b.scheduledFor) {
        if (!features.scheduling) return json(res,402,{error:"Scheduled sending is available on Pro and Business."});
        const sendAt=new Date(b.scheduledFor); if(isNaN(sendAt.getTime())||sendAt.getTime()<=Date.now()) return json(res,400,{error:"Choose a valid future date and time."});
        const recurrence = b.recurrence == null || b.recurrence === "" ? null : String(b.recurrence);
        if (recurrence && !/^(daily|weekly)$/.test(recurrence)) return json(res,400,{error:"Recurrence must be daily or weekly."});
        const scheduleId=id("schedule"); await db().collection("scheduledNotifications").doc(scheduleId).set({uid:user.uid,workspaceId:workspace.id,title,message,audience,segmentId,url:String(b.url||"/"),sendAt:admin.firestore.Timestamp.fromDate(sendAt),status:"pending",createdAt:admin.firestore.FieldValue.serverTimestamp(),recurrence});
        return json(res,200,{ok:true,scheduled:true,scheduleId,sendAt:sendAt.toISOString()});
      }
      const freq=await checkFrequency(workspace.id,[],await workspaceSettings(workspace.id));
      if(!freq.allowed) return json(res,429,{error:freq.reason,code:"FREQUENCY_CAP"});
      const result=await deliverCampaign({uid:user.uid,workspaceId:workspace.id,plan:sub.plan,title,message,url:b.url,audience,segmentId});
      if(!result.ok)return json(res,result.quotaExceeded?402:400,{error:result.error,code:result.quotaExceeded?"NOTIFICATION_QUOTA_EXCEEDED":undefined});
      return json(res,200,result);
    }

    if ((req.method === "GET" || req.method === "POST") && action === "processScheduled") {
      const secret = process.env.CRON_SECRET;
      const authHeader = String(req.headers.authorization || "");
      if (secret && authHeader !== `Bearer ${secret}`) return json(res, 401, { error: "Unauthorized cron invocation." });
      const now = admin.firestore.Timestamp.now();
      const due = await db().collection("scheduledNotifications").where("status", "==", "pending").where("sendAt", "<=", now).limit(20).get();
      let processed = 0;
      for (const doc of due.docs) {
        const s = doc.data();
        try {
          const ownerSnap = await db().collection("users").doc(s.uid).get();
          const ownerData = ownerSnap.exists ? ownerSnap.data() : {};
          const sub = subscriptionInfo(ownerData);
          if (!(PLAN_FEATURES[sub.plan]||PLAN_FEATURES.free).scheduling) { await doc.ref.set({status:"failed",error:"Scheduled sending is no longer available on the current plan.",processedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true}); processed++; continue; }
          const freq = await checkFrequency(s.workspaceId, [], await workspaceSettings(s.workspaceId));
          if (!freq.allowed) {
            const retry = new Date(Date.now() + 15 * 60000);
            await doc.ref.set({ sendAt: admin.firestore.Timestamp.fromDate(retry), lastError: freq.reason, processedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
            processed++; continue;
          }
          const result = await deliverCampaign({ uid:s.uid, workspaceId:s.workspaceId, plan:sub.plan, title:s.title, message:s.message, url:s.url, audience:s.audience||"all", segmentId:s.segmentId||"", scheduled:true });
          if (!result.ok) {
            if (result.quotaExceeded) await doc.ref.set({status:"failed",error:result.error,quotaExceeded:true,processedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
            else await doc.ref.set({status:"failed",error:result.error,processedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
          } else if (s.recurrence && /^(daily|weekly)$/.test(String(s.recurrence))) {
            const next = new Date(s.sendAt.toDate()); next.setUTCDate(next.getUTCDate() + (s.recurrence === "weekly" ? 7 : 1));
            await doc.ref.set({status:"pending",sendAt:admin.firestore.Timestamp.fromDate(next),lastNotificationId:result.notificationId,lastError:null,processedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
          } else {
            await doc.ref.set({status:"sent",notificationId:result.notificationId,processedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
          }
        } catch (e) {
          await doc.ref.set({ status: "failed", error: e.message, processedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        }
        processed++;
      }

      // Process due lightweight automations on the same cron endpoint.
      const autos = await db().collection("automations").where("enabled", "==", true).limit(50).get();
      for (const ad of autos.docs) {
        const a = ad.data();
        try {
          if (a.type === "schedule") {
            const next = a.nextRunAt?.toDate?.();
            if (!next || next.getTime() > Date.now()) continue;
            const owner = await db().collection("users").doc(a.uid).get();
            const ownerData = owner.exists ? owner.data() : {};
            const sub = subscriptionInfo(ownerData);
            if (!(PLAN_FEATURES[sub.plan]||PLAN_FEATURES.free).automation) { await ad.ref.set({enabled:false,lastError:"Automation requires Pro or Business."},{merge:true}); continue; }
            const freq = await checkFrequency(a.workspaceId, [], await workspaceSettings(a.workspaceId));
            if (!freq.allowed) { await ad.ref.set({lastError:freq.reason,lastRunAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true}); continue; }
            const result = await deliverCampaign({uid:a.uid,workspaceId:a.workspaceId,plan:sub.plan,title:a.title||"WyNotify update",message:a.message||"You have a new update.",url:a.url||"/",audience:a.audience||"all"});
            if (result.ok) {
              const nextRun = a.recurrence === "weekly" ? new Date(next) : a.recurrence === "daily" ? new Date(next) : null;
              if (nextRun) nextRun.setUTCDate(nextRun.getUTCDate() + (a.recurrence === "weekly" ? 7 : 1));
              await ad.ref.set({lastRunAt:admin.firestore.FieldValue.serverTimestamp(),lastError:null,nextRunAt:nextRun?admin.firestore.Timestamp.fromDate(nextRun):null,enabled:!!nextRun},{merge:true});
            } else await ad.ref.set({lastError:result.error,lastRunAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
          }
        } catch (e) { await ad.ref.set({lastError:e.message,lastRunAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true}); }
      }

      const rssAutos = autos.docs.filter(d=>d.data().type==="rss");
      for (const ad of rssAutos) {
        const a=ad.data(); if(!a.feedUrl) continue;
        const next = a.nextRunAt?.toDate?.(); if(next && next.getTime()>Date.now()) continue;
        try { const owner=await db().collection("users").doc(a.uid).get(); const sub=subscriptionInfo(owner.exists?owner.data():{}); if (!(PLAN_FEATURES[sub.plan]||PLAN_FEATURES.free).rss) { await ad.ref.set({enabled:false,lastError:"RSS → Push requires Starter or higher."},{merge:true}); continue; } const r=await fetch(a.feedUrl,{headers:{"User-Agent":"WyNotify RSS fetcher/1.0"},signal:AbortSignal.timeout(8000)}); if(!r.ok) { await ad.ref.set({lastError:`Feed returned HTTP ${r.status}`},{merge:true}); continue; } const text=await r.text(); const item=text.match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/i)?.[0]||""; const tm=item.match(/<title[^>]*>([\s\S]*?)<\/title>/i); const latest=tm?tm[1].replace(/<!\[CDATA\[|\]\]>/g,"").replace(/<[^>]+>/g,"").trim():""; if(latest && latest!==a.lastItem){ const result=await deliverCampaign({uid:a.uid,workspaceId:a.workspaceId,plan:sub.plan,title:a.title||latest,message:a.message||latest,url:a.url||"/",audience:a.audience||"all"}); if(result.ok) await ad.ref.set({lastItem:latest,lastRunAt:admin.firestore.FieldValue.serverTimestamp(),lastError:null},{merge:true}); else await ad.ref.set({lastError:result.error,lastRunAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true}); } else await ad.ref.set({lastRunAt:admin.firestore.FieldValue.serverTimestamp(),lastError:null},{merge:true}); } catch(e) { await ad.ref.set({lastError:e.message,lastRunAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true}); }
      }
      return json(res, 200, { ok: true, processed });
    }

    if ((req.method === "GET" || req.method === "POST") && action === "apiKey") {
      const user=await requireUser(req); const {workspace,user:userData}=await workspaceForUser(user.uid);
      if (req.method === "GET") return json(res,200,{ok:true,apiKeyLast4:workspace.apiKeyLast4||null,hasApiKey:!!workspace.apiKeyHash});
      const sub=subscriptionInfo(userData); if(!(PLAN_FEATURES[sub.plan]||PLAN_FEATURES.free).api)return json(res,402,{error:"Developer API access requires Pro or Business."});
      const key=newApiKey(); const next={...workspace,apiKeyHash:apiKeyHash(key),apiKeyLast4:key.slice(-4)}; await db().collection("users").doc(user.uid).set({workspace:next,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true}); return json(res,200,{ok:true,apiKey:key,apiKeyLast4:key.slice(-4)});
    }
    if (req.method === "GET" && action === "exportData") {
      const user=await requireUser(req); const {workspace}=await workspaceForUser(user.uid); const [userSnap,devices,notifications,scheduled,segments,automations,abTests,settings]=await Promise.all([
        db().collection("users").doc(user.uid).get(), db().collection("devices").where("workspaceId","==",workspace.id).get(), db().collection("notifications").where("workspaceId","==",workspace.id).orderBy("createdAt","desc").limit(500).get(), db().collection("scheduledNotifications").where("workspaceId","==",workspace.id).limit(200).get(), db().collection("segments").where("workspaceId","==",workspace.id).limit(200).get(), db().collection("automations").where("workspaceId","==",workspace.id).limit(200).get(), db().collection("abTests").where("workspaceId","==",workspace.id).limit(200).get(), db().collection("workspaceSettings").doc(workspace.id).get()
      ]);
      const stripTS=v=>v?.toDate?.()?.toISOString?.()||v;
      const clean=(d)=>{const x={...d}; for(const k of Object.keys(x)) x[k]=stripTS(x[k]); return x;};
      return json(res,200,{ok:true,version:5,exportedAt:new Date().toISOString(),workspace:{...workspace,apiKeyHash:undefined,apiKeyLast4:undefined},subscription:userSnap.data()?.subscription||{},settings:settings.exists?clean(settings.data()):null,devices:devices.docs.map(d=>{const x=d.data();return {id:d.id,workspaceId:x.workspaceId,ownerUid:x.ownerUid,type:x.type,subscriberType:x.subscriberType,tags:x.tags||[],active:x.active!==false,updatedAt:stripTS(x.updatedAt)}}),notifications:notifications.docs.map(d=>({id:d.id,...clean(d.data())})),scheduled:scheduled.docs.map(d=>({id:d.id,...clean(d.data())})),segments:segments.docs.map(d=>({id:d.id,...clean(d.data())})),automations:automations.docs.map(d=>({id:d.id,...clean(d.data())})),abTests:abTests.docs.map(d=>({id:d.id,...clean(d.data())}))});
    }
    if (req.method === "POST" && action === "restoreData") {
      const user=await requireUser(req); const b=await bodyOf(req); if(!b||![4,5].includes(Number(b.version))||!b.workspace)return json(res,400,{error:"Invalid WyNotify backup."}); const {workspace}=await workspaceForUser(user.uid);
      const cleanTS=(v)=>v?admin.firestore.Timestamp.fromDate(new Date(v)):admin.firestore.FieldValue.serverTimestamp();
      if (b.settings) await db().collection("workspaceSettings").doc(workspace.id).set({workspaceId:workspace.id,dailyCap:Math.max(1,Math.min(20,Number(b.settings.dailyCap||3))),quietMinutes:Math.max(0,Math.min(1440,Number(b.settings.quietMinutes||60)))},{merge:true});
      const groups=["segments","automations","abTests","scheduled","notifications"];
      for(const collection of groups){const rows=Array.isArray(b[collection])?b[collection].slice(0,500):[]; for(const row of rows){const data={...row,workspaceId:workspace.id,uid:user.uid}; delete data.id; delete data.subscription; if(data.createdAt)data.createdAt=cleanTS(data.createdAt); if(data.sendAt)data.sendAt=cleanTS(data.sendAt); if(data.nextRunAt)data.nextRunAt=cleanTS(data.nextRunAt); if(collection==="notifications") { delete data.clickApi; } await db().collection(collection==="scheduled"?"scheduledNotifications":collection).doc(String(row.id||id(collection))).set(data,{merge:true}); }}
      return json(res,200,{ok:true,restored:true,message:"Workspace configuration and message history restored. Subscriber push credentials and billing status were intentionally not restored."});
    }
    if (req.method === "GET" && action === "settings") {
      const user=await requireUser(req); const {workspace}=await workspaceForUser(user.uid); return json(res,200,{ok:true,settings:await workspaceSettings(workspace.id)});
    }
    if (req.method === "POST" && action === "settings") {
      const user=await requireUser(req); const b=await bodyOf(req); const {workspace,user:userData}=await workspaceForUser(user.uid); const sub=subscriptionInfo(userData); if(!(PLAN_FEATURES[sub.plan]||PLAN_FEATURES.free).frequency)return json(res,402,{error:"Frequency controls require Starter or higher."});
      const dailyCap=Math.max(1,Math.min(20,Number(b.dailyCap||3))); const quietMinutes=Math.max(0,Math.min(1440,Number(b.quietMinutes||0))); await db().collection("workspaceSettings").doc(workspace.id).set({workspaceId:workspace.id,dailyCap,quietMinutes,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true}); return json(res,200,{ok:true,settings:{dailyCap,quietMinutes}});
    }
    if (req.method === "GET" && action === "tags") {
      const user=await requireUser(req); const {workspace}=await workspaceForUser(user.uid); const snap=await db().collection("devices").where("workspaceId","==",workspace.id).get(); const counts={}; snap.docs.forEach(d=>(d.data().tags||[]).forEach(t=>{const k=String(t).trim();if(k)counts[k]=(counts[k]||0)+1;})); return json(res,200,{ok:true,tags:Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([name,count])=>({name,count}))});
    }
    if (req.method === "GET" && action === "segments") {
      const user=await requireUser(req); const {workspace,user:userData}=await workspaceForUser(user.uid); const sub=subscriptionInfo(userData); if(!(PLAN_FEATURES[sub.plan]||PLAN_FEATURES.free).segments)return json(res,402,{error:"Segments require Starter or higher."}); const snap=await db().collection("segments").where("workspaceId","==",workspace.id).orderBy("createdAt","desc").limit(100).get(); return json(res,200,{ok:true,segments:snap.docs.map(d=>({id:d.id,...d.data()}))});
    }
    if (req.method === "POST" && action === "segments") {
      const user=await requireUser(req); const b=await bodyOf(req); const {workspace,user:userData}=await workspaceForUser(user.uid); const sub=subscriptionInfo(userData); if(!(PLAN_FEATURES[sub.plan]||PLAN_FEATURES.free).segments)return json(res,402,{error:"Segments require Starter or higher."}); const name=String(b.name||"").trim().slice(0,60); const tags=Array.isArray(b.tags)?[...new Set(b.tags.map(x=>String(x).trim().slice(0,50)).filter(Boolean))].slice(0,20):[]; if(!name||!tags.length)return json(res,400,{error:"Segment name and at least one tag are required."}); const segmentId=id("segment"); await db().collection("segments").doc(segmentId).set({workspaceId:workspace.id,name,tags,createdAt:admin.firestore.FieldValue.serverTimestamp()}); return json(res,200,{ok:true,id:segmentId,name,tags});
    }
    if (req.method === "GET" && action === "inbox") {
      setCors(res,true); const key=String(req.query?.workspaceKey||""); if(!key)return json(res,400,{error:"Workspace key is required."}); if(!(await rateLimit(`inbox:${key}`,req,60)))return json(res,429,{error:"Too many inbox requests. Try again shortly."}); const found=await getWorkspaceByPublicKey(key); if(!found)return json(res,404,{error:"Invalid workspace key."}); const snap=await db().collection("notifications").where("workspaceId","==",found.workspace.id).orderBy("createdAt","desc").limit(30).get(); return json(res,200,{ok:true,items:snap.docs.map(d=>({id:d.id,title:d.data().title,message:d.data().message,url:d.data().url||"/",createdAt:d.data().createdAt?.toDate?.()?.toISOString()||null}))});
    }
    if (req.method === "POST" && action === "automation") {
      const user=await requireUser(req); const b=await bodyOf(req); const {workspace,user:userData}=await workspaceForUser(user.uid); const sub=subscriptionInfo(userData); if(!(PLAN_FEATURES[sub.plan]||PLAN_FEATURES.free).automation)return json(res,402,{error:"Automation requires Pro or Business."}); const type=String(b.type||""); if(!["schedule","rss"].includes(type))return json(res,400,{error:"Unsupported automation type."}); const recurrence=b.recurrence==null||b.recurrence===""?null:String(b.recurrence); if(type==="schedule"&&!recurrence&&!b.nextRunAt)return json(res,400,{error:"A scheduled automation needs a first run time."}); if(recurrence&&!/^(daily|weekly)$/.test(recurrence))return json(res,400,{error:"Recurrence must be daily or weekly."}); const nextDate=b.nextRunAt?new Date(b.nextRunAt):null; if(nextDate&&!Number.isFinite(nextDate.getTime()))return json(res,400,{error:"Invalid next run time."}); const doc={uid:user.uid,workspaceId:workspace.id,type,enabled:b.enabled!==false,title:String(b.title||"").slice(0,120),message:String(b.message||"").slice(0,1000),url:String(b.url||"/"),audience:String(b.audience||"all"),feedUrl:type==="rss"?String(b.feedUrl||""):null,lastItem:String(b.lastItem||""),recurrence,nextRunAt:nextDate?admin.firestore.Timestamp.fromDate(nextDate):null,createdAt:admin.firestore.FieldValue.serverTimestamp()}; const ref=await db().collection("automations").add(doc); return json(res,200,{ok:true,id:ref.id});
    }
    if (req.method === "GET" && action === "automations") {
      const user=await requireUser(req); const {workspace,user:userData}=await workspaceForUser(user.uid); const sub=subscriptionInfo(userData); if(!(PLAN_FEATURES[sub.plan]||PLAN_FEATURES.free).automation)return json(res,402,{error:"Automation requires Pro or Business."}); const snap=await db().collection("automations").where("workspaceId","==",workspace.id).limit(50).get(); return json(res,200,{ok:true,items:snap.docs.map(d=>({id:d.id,...d.data()}))});
    }
    if (req.method === "POST" && action === "abRun") {
      const user=await requireUser(req); const b=await bodyOf(req); const {workspace,user:userData}=await workspaceForUser(user.uid); const sub=subscriptionInfo(userData); if(!(PLAN_FEATURES[sub.plan]||PLAN_FEATURES.free).abTesting)return json(res,402,{error:"A/B testing requires Pro or Business."});
      const a=String(b.variantA||"").trim(), bb=String(b.variantB||"").trim(); if(!a||!bb)return json(res,400,{error:"Both variants are required."}); const testId=id("ab"); const matches=await devicesMatching(workspace.id,String(b.audience||"all"),String(b.segmentId||"")); const deliverable=matches.filter(d=>d.subscription?.endpoint&&d.subscription?.keys?.p256dh&&d.subscription?.keys?.auth); if(deliverable.length<2)return json(res,400,{error:"At least two active subscribers are required for an A/B test."}); const freq=await checkFrequency(workspace.id,[],await workspaceSettings(workspace.id)); if(!freq.allowed)return json(res,429,{error:freq.reason}); const quota=await reserveNotificationSlot(workspace.id,sub.plan); if(!quota.allowed)return json(res,402,{error:`Monthly notification limit reached (${quota.limit}).`,code:"NOTIFICATION_QUOTA_EXCEEDED"});
      for(let i=deliverable.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[deliverable[i],deliverable[j]]=[deliverable[j],deliverable[i]];} const mid=Math.ceil(deliverable.length/2); const groups=[["A",a,deliverable.slice(0,mid)],["B",bb,deliverable.slice(mid)]]; const results=[]; for(const [variant,text,group] of groups){if(!group.length)continue; const nid=id("notification"); const r=await deliverToDevices({deliverable:group,title:String(b.title||"Notification"),message:text,url:b.url,notificationId:nid}); await db().collection("notifications").doc(nid).set({uid:user.uid,workspaceId:workspace.id,title:String(b.title||"Notification"),message:text,audience:String(b.audience||"all"),segmentId:String(b.segmentId||"")||null,variant,abTestId:testId,campaignId:testId,count:r.tokens.length,successCount:r.successCount,failureCount:r.failureCount,clicks:0,status:r.successCount?"sent":"failed",createdAt:admin.firestore.FieldValue.serverTimestamp()}); if(r.invalid.length)await Promise.all(r.invalid.map(x=>db().collection("devices").doc(x).set({active:false},{merge:true}))); results.push({variant,matched:r.tokens.length,sent:r.successCount,failed:r.failureCount}); }
      await db().collection("abTests").doc(testId).set({uid:user.uid,workspaceId:workspace.id,title:String(b.title||"Notification"),variantA:a,variantB:bb,status:"sent",audience:String(b.audience||"all"),createdAt:admin.firestore.FieldValue.serverTimestamp(),results}); return json(res,200,{ok:true,testId,results});
    }
    if (req.method === "GET" && action === "abTests") {
      const user=await requireUser(req); const {workspace}=await workspaceForUser(user.uid); const snap=await db().collection("abTests").where("workspaceId","==",workspace.id).orderBy("createdAt","desc").limit(30).get(); return json(res,200,{ok:true,items:snap.docs.map(d=>({id:d.id,...d.data()}))});
    }

    if (req.method === "POST" && action === "trackClick") {
      setCors(res, true);
      const b = await bodyOf(req); const notificationId = String(b.id || "");
      if (!notificationId) return json(res, 400, { error: "Notification id is required." });
      if (!(await rateLimit(`click:${notificationId}`, req, 60))) return json(res, 429, { error: "Too many click events." });
      const ref = db().collection("notifications").doc(notificationId);
      const snap = await ref.get();
      if (!snap.exists) return json(res, 404, { error: "Notification not found." });
      await ref.set({ clicks: admin.firestore.FieldValue.increment(1), lastClickedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && action === "rssCheck") {
      const user = await requireUser(req); const b = await bodyOf(req); const url = String(b.feedUrl || "").trim();
      if (!/^https?:\/\//i.test(url)) return json(res, 400, { error: "Enter a valid HTTP(S) feed URL." });
      const { user: userData } = await workspaceForUser(user.uid); const sub = subscriptionInfo(userData);
      if (!(PLAN_FEATURES[sub.plan]||PLAN_FEATURES.free).rss) return json(res, 402, { error: "RSS → Push is available on Starter, Pro and Business plans." });
      if (!(await rateLimit("rss", req, 10))) return json(res, 429, { error: "Too many feed checks. Try again later." });
      const r = await fetch(url, { headers: { "User-Agent": "WyNotify RSS fetcher/1.0" }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) return json(res, 400, { error: `Feed returned HTTP ${r.status}.` });
      const text = await r.text(); const items = [...text.matchAll(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi)].map(m=>m[0]);
      const titleMatch = items[0]?.match(/<title[^>]*>([\s\S]*?)<\/title>/i); const latest = titleMatch ? titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g,"").replace(/<[^>]+>/g,"").trim() : "";
      return json(res, 200, { ok: true, items: items.length, latest });
    }

    if (req.method === "GET" && action === "dashboard") {
      const user = await requireUser(req); const { workspace, user: userData } = await workspaceForUser(user.uid);
      const [n, d, s] = await Promise.all([
        db().collection("notifications").where("workspaceId", "==", workspace.id).orderBy("createdAt", "desc").limit(100).get(),
        db().collection("devices").where("workspaceId", "==", workspace.id).get(),
        db().collection("scheduledNotifications").where("workspaceId", "==", workspace.id).where("status", "==", "pending").orderBy("sendAt", "asc").limit(20).get()
      ]);
      const active = d.docs.filter(x => x.data().active !== false); const sub = subscriptionInfo(userData);
      const recent = n.docs.map(x => ({ id: x.id, ...x.data(), createdAt: x.data().createdAt?.toDate?.()?.toISOString() || null })).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
      const scheduled = s.docs.map(x => ({ id: x.id, ...x.data(), sendAt: x.data().sendAt?.toDate?.()?.toISOString() || null }));
      const usage = await notificationUsage(workspace.id);
      const notificationLimit = PLANS[sub.plan]?.notifications || PLANS.free.notifications;
      return json(res, 200, { ok: true, workspace, subscription: { ...userData?.subscription, plan: sub.plan, active: sub.active, expiresAt: sub.expiresAt, capabilities: PLAN_FEATURES[sub.plan] || PLAN_FEATURES.free }, subscribers: active.length, notifications: n.size, notificationUsage: { used: usage.count, limit: notificationLimit, period: usage.period }, recent, scheduled, registration: { workspaceKey: workspace.publicKey, endpoint: "/api?action=registerDevice", apiKeyLast4: workspace.apiKeyLast4 || null, hasApiKey: !!workspace.apiKeyHash } });
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
      if (chargeId) {
        try { const r = await flw(`/charges/${encodeURIComponent(chargeId)}`, { method: "GET" }); charge = r?.data || null; }
        catch (e) {
          console.error("webhook charge verification", e.message);
          // Do NOT mark this event processed: if verification failed transiently, leaving it
          // unprocessed lets Flutterwave's retry succeed later. Marking it processed here would
          // make that retry look like a duplicate and silently drop the event forever.
          return json(res, 502, { error: "Could not verify charge with Flutterwave; will retry." });
        }
      }
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
