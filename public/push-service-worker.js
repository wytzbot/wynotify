/* WyNotify push worker is generated during npm run build from Vercel environment variables. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
