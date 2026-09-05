/* WyNotify dashboard push worker v4.15.1. No Firebase Messaging SDK is used for push. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter((key) => /^wynotify(?:-|_)/i.test(key)).map((key) => caches.delete(key)));
  await self.clients.claim();
})()));
self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = { body: event.data?.text?.() || "" }; }
  const n = payload.notification || payload;
  event.waitUntil(self.registration.showNotification(n.title || "WyNotify", {
    body: n.body || "",
    icon: n.icon || "/favicon.svg",
    badge: n.badge || "/favicon.svg",
    data: { url: n.url || payload.data?.url || "/", notificationId: payload.data?.notificationId || "", clickApi: payload.data?.clickApi || "" }
  }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.url || "/";
  event.waitUntil((async () => {
    if (data.clickApi && data.notificationId) {
      try { await fetch(data.clickApi, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: data.notificationId }) }); } catch {}
    }
    const list = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of list) {
      if ("focus" in client) { await client.navigate(url); return client.focus(); }
    }
    return clients.openWindow(url);
  })());
});
