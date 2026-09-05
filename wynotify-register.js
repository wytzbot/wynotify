/**
 * WyNotify drop-in website subscriber widget.
 *
 * Add this to any HTTPS website:
 * <script src="https://YOUR-WYNOTIFY-DOMAIN.com/wynotify-register.js"
 *   data-workspace-key="YOUR_PUBLIC_KEY"
 *   data-api="https://YOUR-WYNOTIFY-DOMAIN.com/api"
 *   data-label="Get updates" async></script>
 *
 * Also copy /wynotify-push-sw.js to the website root as /wynotify-push-sw.js.
 * No dashboard account is required for visitors.
 */
(function () {
  "use strict";
  const script = document.currentScript;
  if (!script) return;
  const workspaceKey = script.dataset.workspaceKey || script.getAttribute("data-workspace-key") || document.querySelector('meta[name="wynotify-workspace-key"]')?.content || "";
  const apiBase = (script.dataset.api || script.getAttribute("data-api") || document.querySelector('meta[name="wynotify-api"]')?.content || new URL("/api", script.src).href).replace(/\/$/, "");
  const label = script.dataset.label || "Get updates";
  const type = script.dataset.type || "customers";
  const tags = (script.dataset.tags || "").split(",").map(x => x.trim()).filter(Boolean);
  if (!workspaceKey) { console.warn("WyNotify: add data-workspace-key to the script."); return; }

  const firebaseVersion = "12.3.0";
  const load = (src) => new Promise((resolve, reject) => {
    const s = document.createElement("script"); s.src = src; s.onload = resolve; s.onerror = reject; document.head.appendChild(s);
  });
  const style = document.createElement("style");
  style.textContent = ".wynotify-subscribe{font:600 14px system-ui,-apple-system,sans-serif;border:0;border-radius:10px;padding:11px 16px;background:#111827;color:#fff;cursor:pointer;box-shadow:0 2px 10px #0002}.wynotify-subscribe:disabled{opacity:.65;cursor:wait}.wynotify-subscribe.ok{background:#166534}";
  document.head.appendChild(style);

  async function config() {
    const r = await fetch(apiBase + "?action=publicConfig&workspaceKey=" + encodeURIComponent(workspaceKey));
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Could not connect to WyNotify."); return d;
  }
  async function subscribe(button) {
    if (!("Notification" in window) || !("serviceWorker" in navigator)) throw new Error("Push notifications are not supported by this browser.");
    if (location.protocol !== "https:" && location.hostname !== "localhost") throw new Error("Notifications require a secure HTTPS website.");
    button.disabled = true; button.textContent = "Connecting…";
    const cfg = await config();
    await load("https://www.gstatic.com/firebasejs/" + firebaseVersion + "/firebase-app-compat.js");
    await load("https://www.gstatic.com/firebasejs/" + firebaseVersion + "/firebase-messaging-compat.js");
    if (!window.firebase) throw new Error("Notification library could not load.");
    if (!firebase.apps.length) firebase.initializeApp(cfg.firebase);
    const registration = await navigator.serviceWorker.register("/wynotify-push-sw.js?workspaceKey=" + encodeURIComponent(workspaceKey) + "&api=" + encodeURIComponent(apiBase), { scope: "/" });
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Notification permission was not granted.");
    const token = await firebase.messaging().getToken({ vapidKey: cfg.vapidKey, serviceWorkerRegistration: registration });
    if (!token) throw new Error("Could not create a notification subscription.");
    const r = await fetch(apiBase + "?action=registerDevice", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaceKey, token, subscriberType: type, tags }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Could not save your subscription.");
    button.disabled = false; button.textContent = "✓ Subscribed"; button.classList.add("ok");
    return d;
  }
  function mount() {
    const button = document.createElement("button"); button.type = "button"; button.className = "wynotify-subscribe"; button.textContent = label;
    button.addEventListener("click", () => subscribe(button).catch(err => { button.disabled = false; button.textContent = label; alert(err.message || "Could not enable notifications."); }));
    const target = script.parentNode; if (target) target.insertBefore(button, script.nextSibling);
    window.WyNotify = window.WyNotify || {}; window.WyNotify.subscribe = () => subscribe(button);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
})();
