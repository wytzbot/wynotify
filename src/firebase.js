import { initializeApp } from "firebase/app";
import { getAnalytics, isSupported } from "firebase/analytics";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getMessaging, isSupported as messagingSupported, getToken, onMessage } from "firebase/messaging";

const required = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const missing = Object.entries(required).filter(([, value]) => !value).map(([key]) => key);
if (missing.length) {
  throw new Error(`Push service configuration is incomplete. Missing: ${missing.join(", ")}`);
}

const firebaseConfig = {
  ...required,
  ...(import.meta.env.VITE_FIREBASE_MEASUREMENT_ID ? { measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID } : {}),
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const analyticsPromise = isSupported().then((ok) => (ok ? getAnalytics(app) : null)).catch(() => null);
export const authReady = signInAnonymously(auth).catch((e) => {
  console.error("Anonymous account session failed", e);
  throw e;
});

export const waitForUser = () => new Promise((resolve, reject) => {
  let done = false;
  const off = onAuthStateChanged(auth, (u) => {
    if (u && !done) {
      done = true;
      off();
      resolve(u);
    }
  });
  setTimeout(() => {
    if (!done) {
      done = true;
      off();
      reject(new Error("Account session timed out."));
    }
  }, 10000);
});

export async function authHeader() {
  const u = await waitForUser();
  return { Authorization: `Bearer ${await u.getIdToken()}` };
}

export async function getPushToken() {
  if (!(await messagingSupported())) throw new Error("Push notifications are not supported by this browser.");
  const vapid = import.meta.env.VITE_FIREBASE_VAPID_KEY;
  if (!vapid) throw new Error("VITE_FIREBASE_VAPID_KEY is missing. Add your Web Push certificate key.");
  if (!("Notification" in window)) throw new Error("This browser does not support notifications.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notification permission was not granted.");
  const registration = await navigator.serviceWorker.getRegistration("/push-service-worker.js") || await navigator.serviceWorker.register("/push-service-worker.js");
  const token = await getToken(getMessaging(app), { vapidKey: vapid, serviceWorkerRegistration: registration });
  if (!token) throw new Error("The push service did not return a registration token.");
  return token;
}

export async function registerPush() {
  const token = await getPushToken();
  const r = await fetch("/api?action=registerDevice", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ token }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "Could not register device.");
  return token;
}

export async function registerCustomerPush(workspaceKey, { subscriberType = "customers", tags = [] } = {}) {
  if (!workspaceKey) throw new Error("Workspace registration key is required.");
  const token = await getPushToken();
  const r = await fetch("/api?action=registerDevice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceKey, token, subscriberType, tags }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "Could not register customer device.");
  return token;
}

export async function listenForMessages(cb) {
  if (!(await messagingSupported())) return () => {};
  return onMessage(getMessaging(app), cb);
}
