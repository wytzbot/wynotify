/* WyNotify website push worker v4.15.1. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter((key) => /^wynotify(?:-|_)/i.test(key)).map((key) => caches.delete(key)));
  await self.clients.claim();
})()));

self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = { body: event.data?.text?.() || "" }; }
  const notification = payload.notification || payload;
  const title = notification.title || "New update";
  const body = notification.body || "You have a new notification.";
  const clickUrl = notification.url || payload.data?.url || "/";
  const options = {
    body,
    icon: notification.icon || "/favicon.svg",
    badge: notification.badge || "/favicon.svg",
    data: {
      clickUrl,
      notificationId: payload.data?.notificationId || payload.notificationId || "",
      clickApi: payload.data?.clickApi || ""
    }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.clickUrl || "/";
  event.waitUntil((async () => {
    if (data.clickApi && data.notificationId) {
      try { await fetch(data.clickApi, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: data.notificationId }) }); } catch {}
    }
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if ("focus" in client) { await client.navigate(url); return client.focus(); }
    }
    return clients.openWindow(url);
  })());
});
