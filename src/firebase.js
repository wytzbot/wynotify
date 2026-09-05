import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";

// __APP_VERSION__ is injected by vite.config.js from package.json — the one
// place the version number is actually typed in.
const APP_VERSION = __APP_VERSION__;
const SW_URL = `/push-service-worker.js?v=${APP_VERSION}`;

const required = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const missing = Object.entries(required).filter(([, value]) => !value).map(([key]) => key);
if (missing.length) throw new Error(`Workspace configuration is incomplete. Missing: ${missing.join(", ")}`);

export const app = initializeApp(required);
export const auth = getAuth(app);
export const authReady = signInAnonymously(auth).catch((e) => {
  console.error("Account session failed", e);
  throw e;
});

export const waitForUser = () => new Promise((resolve, reject) => {
  let done = false;
  const off = onAuthStateChanged(auth, (u) => {
    if (u && !done) { done = true; off(); resolve(u); }
  });
  setTimeout(() => {
    if (!done) { done = true; off(); reject(new Error("Account session timed out.")); }
  }, 10000);
});

export async function authHeader() {
  const u = await waitForUser();
  return { Authorization: `Bearer ${await u.getIdToken()}` };
}

async function pushConfig() {
  const r = await fetch(`/api?action=publicConfig`, { cache: "no-store" });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.publicKey) throw new Error(d.error || "Push notification setup is incomplete.");
  return d;
}

function base64UrlToUint8Array(base64UrlData) {
  const padding = "=".repeat((4 - (base64UrlData.length % 4)) % 4);
  const base64 = (base64UrlData + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

export async function getPushSubscription() {
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("Push notifications are not supported by this browser.");
  }
  if (location.protocol !== "https:" && location.hostname !== "localhost") throw new Error("Notifications require a secure HTTPS website.");
  const cfg = await pushConfig();
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notification permission was not granted.");
  const registration = await navigator.serviceWorker.getRegistration("/").then(async r => { if (r) { await r.update().catch(() => {}); return r; } return navigator.serviceWorker.register(SW_URL, { scope: "/", updateViaCache: "none" }); });
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToUint8Array(cfg.publicKey) });
  return subscription;
}

export async function registerPush() {
  const subscription = await getPushSubscription();
  const r = await fetch("/api?action=registerDevice", {
    cache: "no-store",
    method: "POST", headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ subscription: subscription.toJSON(), subscriberType: "workspace" }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "Could not register this device.");
  return subscription;
}

// Customer-facing (third-party website) subscription is handled entirely by
// the standalone /wynotify-register.js widget, which website owners embed on
// their own site. That widget is not bundled into this dashboard app, so it
// carries its own copy of this same subscribe flow rather than importing
// from here — there used to be a second, unused copy of that flow in this
// file that could silently drift out of sync with the real one; it has been
// removed. If the dashboard ever needs to trigger a customer-style
// subscription itself, reuse the logic in /wynotify-register.js rather than
// re-adding a parallel implementation here.

export async function listenForMessages() { return () => {}; }
