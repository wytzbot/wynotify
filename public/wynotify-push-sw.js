/* WyNotify website push worker. This file is intentionally provider-neutral to site owners. */
const params = new URL(self.location.href).searchParams;
const workspaceKey = params.get("workspaceKey") || "";
const apiBase = params.get("api") || new URL("/api", self.location.origin).href;

let ready = false;
let initPromise;

async function init() {
  if (ready) return;
  const base = apiBase.replace(/\/$/, "");
  const res = await fetch(`${base}?action=publicConfig&workspaceKey=${encodeURIComponent(workspaceKey)}`);
  if (!res.ok) throw new Error("Could not load notification configuration.");
  const cfg = await res.json();
  importScripts("https://www.gstatic.com/firebasejs/12.3.0/firebase-app-compat.js", "https://www.gstatic.com/firebasejs/12.3.0/firebase-messaging-compat.js");
  firebase.initializeApp(cfg.firebase);
  const messaging = firebase.messaging();
  messaging.onBackgroundMessage((payload) => {
    const title = payload.notification?.title || payload.data?.title || "New update";
    const body = payload.notification?.body || payload.data?.body || "You have a new notification.";
    const clickUrl = payload.data?.clickUrl || payload.fcmOptions?.link || "/";
    self.registration.showNotification(title, { body, icon: "/favicon.svg", badge: "/favicon.svg", data: { clickUrl } });
  });
  ready = true;
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Initialize immediately so background notifications work even when the page is closed.
initPromise = init().catch((error) => {
  console.error("WyNotify push worker initialization failed", error);
});
self.addEventListener("message", (event) => {
  if (event.data?.type === "INIT") initPromise = init().catch(() => {});
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.clickUrl || "/";
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    const existing = list.find((client) => "focus" in client);
    if (existing) return existing.navigate(url).then(() => existing.focus());
    return clients.openWindow(url);
  }));
});
