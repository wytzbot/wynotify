/**
 * WyNotify provider-neutral website subscriber widget.
 *
 * Add to <head>:
 * <meta name="wynotify-workspace-key" content="YOUR_PUBLIC_KEY">
 * <meta name="wynotify-api" content="https://YOUR-WYNOTIFY-DOMAIN.com/api">
 * <script src="https://YOUR-WYNOTIFY-DOMAIN.com/wynotify-register.js?v=4.15.1" async></script>
 *
 * Copy /wynotify-push-sw.js from WyNotify to your website root as
 * /wynotify-push-sw.js. No provider account or notification SDK is required on the customer website.
 */
(function () {
  const WYN_NOTIFY_VERSION = "4.15.1";
  "use strict";
  const script = document.currentScript;
  if (!script) return;
  const workspaceKey = script.dataset.workspaceKey || document.querySelector('meta[name="wynotify-workspace-key"]')?.content || "";
  const apiBase = (script.dataset.api || document.querySelector('meta[name="wynotify-api"]')?.content || new URL("/api", script.src).href).replace(/\/$/, "");
  const label = script.dataset.label || "Get updates";
  const type = script.dataset.type || "customers";
  const tags = (script.dataset.tags || "").split(",").map(x => x.trim()).filter(Boolean);
  const customColor = script.dataset.color || document.querySelector('meta[name="wynotify-color"]')?.content || "";
  if (!workspaceKey) { console.warn("WyNotify: add data-workspace-key or the wynotify-workspace-key meta tag."); return; }

  const style = document.createElement("style");
  style.textContent = `
    .wynotify-subscribe{font:600 14px/1.2 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;border:1px solid var(--wy-border,#0002);border-radius:var(--wy-radius,10px);padding:11px 16px;background:var(--wy-accent,#111827);color:var(--wy-text,#fff);cursor:pointer;box-shadow:0 2px 10px #0002;transition:.18s ease}
    .wynotify-subscribe:hover{filter:brightness(.96);transform:translateY(-1px)}
    .wynotify-subscribe:disabled{opacity:.65;cursor:wait;transform:none}
    .wynotify-subscribe.ok{background:var(--wy-success,#166534)}
    .wynotify-backdrop{position:fixed;inset:0;z-index:2147483646;background:#0007;display:grid;place-items:center;padding:20px;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .wynotify-dialog{width:min(420px,100%);background:var(--wy-surface,#fff);color:var(--wy-ink,#111827);border:1px solid var(--wy-border,#0002);border-radius:18px;padding:24px;box-shadow:0 20px 60px #0005}
    .wynotify-icon{width:46px;height:46px;border-radius:14px;display:grid;place-items:center;background:var(--wy-accent,#111827);color:var(--wy-text,#fff);font-size:22px;margin-bottom:14px}
    .wynotify-dialog h3{margin:0 0 8px;font-size:20px}.wynotify-dialog p{margin:0 0 18px;line-height:1.55;font-size:14px;opacity:.78}
    .wynotify-actions{display:flex;gap:10px;justify-content:flex-end}.wynotify-actions button{border:0;border-radius:10px;padding:11px 15px;font:600 14px system-ui;cursor:pointer}.wynotify-cancel{background:transparent;color:inherit;border:1px solid var(--wy-border,#0002)!important}.wynotify-allow{background:var(--wy-accent,#111827);color:var(--wy-text,#fff)}
    @media(max-width:480px){.wynotify-dialog{padding:20px}.wynotify-actions{flex-direction:column}.wynotify-actions button{width:100%}}
  `;
  document.head.appendChild(style);

  function normalizeColor(value) {
    if (!value) return "";
    const v = value.trim();
    if (/^(#|rgb|hsl|oklch|lab|color\()/i.test(v)) return v;
    return "";
  }
  function siteColor(button) {
    const candidates = [customColor, getComputedStyle(document.documentElement).getPropertyValue("--primary-color"), getComputedStyle(document.documentElement).getPropertyValue("--primary"), getComputedStyle(document.documentElement).getPropertyValue("--accent-color"), getComputedStyle(document.documentElement).getPropertyValue("--accent"), document.querySelector('meta[name="theme-color"]')?.content];
    for (const c of candidates) { const n = normalizeColor(c); if (n) return n; }
    if (button) {
      const bg = getComputedStyle(button).backgroundColor;
      if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
    }
    const buttons = [...document.querySelectorAll("button,a")].slice(0, 30);
    for (const el of buttons) { const bg = getComputedStyle(el).backgroundColor; if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg; }
    return "#111827";
  }
  function luminance(color) {
    let rgb;
    const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (m) rgb = [Number(m[1]), Number(m[2]), Number(m[3])];
    else {
      const h = color.trim().replace(/^#/, "");
      const hex = h.length === 3 ? h.split("").map(x => x + x).join("") : h;
      if (/^[0-9a-f]{6}$/i.test(hex)) rgb = [parseInt(hex.slice(0,2),16), parseInt(hex.slice(2,4),16), parseInt(hex.slice(4,6),16)];
    }
    if (!rgb) return null;
    const values = rgb.map(c => c / 255).map(c => c <= .03928 ? c / 12.92 : Math.pow((c + .055) / 1.055, 2.4));
    return .2126*values[0] + .7152*values[1] + .0722*values[2];
  }
  function readableText(color) {
    const l = luminance(color);
    return l !== null && l > .55 ? "#111827" : "#fff";
  }
  async function config() {
    const r = await fetch(apiBase + "?action=publicConfig&workspaceKey=" + encodeURIComponent(workspaceKey), { credentials: "omit" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.publicKey) throw new Error(d.error || "Could not connect to WyNotify.");
    return d;
  }
  function bytesFromBase64Url(value) {
    const padding = "=".repeat((4 - (value.length % 4)) % 4);
    const raw = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
  }
  const PUSH_SCOPE = "/__wynotify_push__/";
  const PUSH_WORKER_URL = `/wynotify-push-sw.js?v=${WYN_NOTIFY_VERSION}`;
  async function subscribe(button) {
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("Push notifications are not supported by this browser.");
    if (location.protocol !== "https:" && location.hostname !== "localhost") throw new Error("Notifications require a secure HTTPS website.");
    button.disabled = true; button.textContent = "Connecting…";
    // Ask immediately from the button click, before network work, so the browser
    // sees a direct user gesture. PushManager.subscribe() is also initiated from
    // this same user-driven flow.
    const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Notification permission was not granted.");
    const cfg = await config();
    // Do not reuse the host site's root service worker. It may belong to a PWA,
    // cache layer or another push provider. A dedicated scope keeps WyNotify isolated.
    const registration = await navigator.serviceWorker.getRegistration(PUSH_SCOPE) || await navigator.serviceWorker.register(PUSH_WORKER_URL, { scope: PUSH_SCOPE, updateViaCache: "none" });
    if (!registration.active) {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Notification service worker did not become ready.")), 15000);
        const check = () => { if (registration.active) { clearTimeout(timeout); resolve(); } };
        registration.addEventListener("updatefound", () => registration.installing?.addEventListener("statechange", check));
        check();
      });
    }
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytesFromBase64Url(cfg.publicKey) });
    const r = await fetch(apiBase + "?action=registerDevice", { cache: "no-store", method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaceKey, subscription: subscription.toJSON(), subscriberType: type, tags }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "Could not save your subscription.");
    button.disabled = false; button.textContent = "✓ Subscribed"; button.classList.add("ok");
    return d;
  }
  function showPrompt(button) {
    const accent = siteColor(button); const text = readableText(accent);
    const backdrop = document.createElement("div"); backdrop.className = "wynotify-backdrop";
    const dialog = document.createElement("div"); dialog.className = "wynotify-dialog";
    dialog.style.setProperty("--wy-accent", accent); dialog.style.setProperty("--wy-text", text);
    dialog.innerHTML = `<div class="wynotify-icon">🔔</div><h3>Stay updated</h3><p>Allow notifications from this site for new updates, offers and important messages. You can change this permission anytime in your browser settings.</p><div class="wynotify-actions"><button type="button" class="wynotify-cancel">Not now</button><button type="button" class="wynotify-allow">Allow updates</button></div>`;
    backdrop.appendChild(dialog); document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    dialog.querySelector(".wynotify-cancel").onclick = close;
    dialog.querySelector(".wynotify-allow").onclick = async () => { close(); try { await subscribe(button); } catch (err) { button.disabled = false; button.textContent = label; console.warn("WyNotify:", err); } };
    backdrop.addEventListener("click", e => { if (e.target === backdrop) close(); });
  }
  function mount() {
    const button = document.createElement("button"); button.type = "button"; button.className = "wynotify-subscribe"; button.textContent = label;
    button.addEventListener("click", () => showPrompt(button));
    const target = script.parentNode === document.head ? document.body : script.parentNode;
    if (target) target.appendChild(button);
    window.WyNotify = window.WyNotify || {}; window.WyNotify.subscribe = () => showPrompt(button);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
})();
