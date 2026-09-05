import fs from 'node:fs';
import path from 'node:path';

// package.json is the single source of truth for the app version. This
// script (run as the "prebuild" step) is what stamps that version into every
// static file Vite's `define` can't reach — plain files under public/ and
// index.html — so a release only ever has to bump package.json once.
const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
const version = pkg.version;
if (!version) throw new Error('package.json has no "version" field to stamp into the build.');

// --- Dashboard push worker: fully generated, so the version just gets
// interpolated straight into the banner comment. ---
const source = `/* WyNotify dashboard push worker v${version}. No Firebase Messaging SDK is used for push. */
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
`;
fs.writeFileSync(path.resolve('public/push-service-worker.js'), source);

// --- version.json: what the running dashboard polls to notice a stale tab. ---
fs.writeFileSync(path.resolve('public/version.json'), JSON.stringify({ app: 'WyNotify', version }, null, 2) + '\n');

// --- Files that already have real, hand-written content: patch just the
// version marker in each, and fail loudly if the marker can't be found, so a
// future edit that changes the surrounding text can't silently leave a
// stale version behind. ---
function patchVersion(file, pattern, replacement, label) {
  const filePath = path.resolve(file);
  const content = fs.readFileSync(filePath, 'utf8');
  if (!pattern.test(content)) throw new Error(`generate-sw: could not find the ${label} marker in ${file}. Update the pattern in scripts/generate-sw.mjs.`);
  fs.writeFileSync(filePath, content.replace(pattern, replacement));
}

patchVersion(
  'public/wynotify-push-sw.js',
  /\/\* WyNotify website push worker v[^*]*\*\//,
  `/* WyNotify website push worker v${version}. */`,
  'website push worker banner'
);

patchVersion(
  'public/wynotify-register.js',
  /const WYN_NOTIFY_VERSION = "[^"]*";/,
  `const WYN_NOTIFY_VERSION = "${version}";`,
  'WYN_NOTIFY_VERSION constant'
);

patchVersion(
  'index.html',
  /<meta name="application-version" content="[^"]*">/,
  `<meta name="application-version" content="${version}">`,
  'application-version meta tag'
);

console.log(`Generated provider-neutral WyNotify push worker and stamped v${version} across public/version.json, wynotify-push-sw.js, wynotify-register.js and index.html.`);
