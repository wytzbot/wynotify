# WyNotify

WyNotify is a simple customer notification platform for businesses, website owners and app owners. The main experience is designed for non-technical users: connect a site or app, grow an opted-in audience, send messages, and review delivery results.

Developers still get SDK/API integration tools under **Advanced tools**.

## Why WyNotify

- Simple business-first dashboard
- One-click device test
- Customer subscriber management
- Ready-made notification templates
- Audience tags and targeting support
- Delivery reporting
- Website/app developer integration
- SDK examples and REST API
- Secure payment flow
- PWA/mobile-friendly interface

## What changed in this update

**Fixes**

- The website push integration uses the standard Web Push protocol with VAPID. Website owners only add the WyNotify worker and subscriber snippet; no separate notification-provider account is required.
- Pricing uses fixed checkout equivalents: Starter $5 / ₦7,500, Pro $10 / ₦15,000, Business $15 / ₦22,500.
- **Notification-based pricing:** subscriber count is not a billing limit. Free includes 100 notification sends per calendar month; paid plans increase the monthly send allowance. A notification campaign counts once regardless of how many opted-in subscribers receive it.

**New business-focused features**

- **Click-through tracking** (free, all plans) — every notification now records how many customers actually tapped it, shown next to sent/failed counts. Click analytics are built into WyNotify so owners can see engagement without building a separate tracking system.
- **100 free sends/month** — WyNotify no longer charges based on subscriber count. The first 100 notification campaigns each month are free; after that the workspace must upgrade.
- **Scheduled sending** (Pro and Business) — compose a message and pick a future date/time instead of sending immediately. A Vercel Cron job (`/api?action=processScheduled`, every 5 minutes) flushes due messages. Requires a new `CRON_SECRET` environment variable (see below) — Vercel sends it automatically as a bearer token once you set it.

### New/updated environment variable

- `CRON_SECRET` — a random string (16+ chars). Set it in Vercel's env vars; Vercel automatically sends it as `Authorization: Bearer $CRON_SECRET` when it invokes the cron job, and the API checks it against that header. Without it the cron endpoint still works but is unauthenticated — set it before going live.

### Ideas for future product improvements

- A/B testing two message variants against a split audience
- Recurring/automated sends (e.g. a weekly digest) rather than one-off scheduling
- Team seats with per-user permissions on Business plan
- Outbound webhooks so a store's own backend hears about opens/clicks

## Basic workflow

1. Create/open your WyNotify workspace.
2. Use **Connect app** to test the current device or hand the integration details to your developer.
3. Add the notification registration code to your website/app.
4. Customers opt in to notifications.
5. Send promotions, announcements, updates and alerts from **Send notification**.
6. Review delivery results in the dashboard.

## Vercel environment variables

Set these in **Vercel → Project → Settings → Environment Variables**.

### Dashboard configuration

WyNotify keeps account, workspace and delivery data on its server-side infrastructure. Customers who connect their websites do not configure the underlying infrastructure.

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`
- `VITE_SUPPORT_EMAIL` — optional

### Web Push configuration

Generate one VAPID key pair and keep the private key server-side. The public key is safe to expose to browsers. The `web-push` package supports VAPID key generation and Web Push delivery.

To generate a pair locally after installing dependencies, run `npm run generate:vapid`. Add the three printed values to Vercel as server environment variables. Generate the pair once and keep using the same keys so existing subscriptions remain valid.

- `WEB_PUSH_PUBLIC_KEY`
- `WEB_PUSH_PRIVATE_KEY`
- `WEB_PUSH_SUBJECT` — for example `mailto:notifications@yourdomain.com`

### Server-only secrets

- `FIREBASE_SERVICE_ACCOUNT_JSON` — complete service-account JSON. Never expose this to the browser.
- `FLW_CLIENT_ID`
- `FLW_CLIENT_SECRET`
- `FLW_SECRET_HASH`
- `FLW_SANDBOX` — `true` for testing, `false` for live payments
- `APP_URL` — deployed public URL, for example `https://your-domain.vercel.app`

Never add server secrets with a `VITE_` prefix.

## Search and AI crawler support

The production build includes `robots.txt`, a sitemap, and `llms.txt`. Public marketing information can be discovered by search engines and AI crawlers while API routes remain disallowed from crawling.

## Integration

The dashboard provides a public workspace registration key and a registration endpoint for developer integrations. The key can register opted-in customer devices but cannot send notifications or access the owner's dashboard.

Only send notifications to people who have legitimately opted in.

## Deployment

Install dependencies and run:

```bash
npm run build
```

The build generates the WyNotify dashboard push service worker. The separate website subscriber worker uses standard Web Push and contains no third-party push SDK.


## Website subscriber button — `<head>` setup

WyNotify can collect browser push subscribers from a normal HTTPS website. The website owner does not need to create a separate push-provider project.

### 1. Download the worker

From the WyNotify **Integrations** page, download `wynotify-push-sw.js`. Upload it to the **root** of the customer website so this exact URL works:

```text
https://YOUR-SITE.com/wynotify-push-sw.js
```

### 2. Paste this code inside `<head>`

```html
<meta name="wynotify-workspace-key" content="YOUR_PUBLIC_KEY">
<meta name="wynotify-api" content="https://YOUR-WYNOTIFY-DOMAIN.com/api">
<script src="https://YOUR-WYNOTIFY-DOMAIN.com/wynotify-register.js?v=4.15.1" data-label="Get updates" async></script>
```

**Immediately after the code above:**

1. Replace `YOUR_PUBLIC_KEY` with the public workspace key from WyNotify.
2. Replace `YOUR-WYNOTIFY-DOMAIN.com` with your live WyNotify domain.
3. Publish the website over **HTTPS**.
4. Open the website and click **Get updates**.
5. Click **Allow updates** in the WyNotify dialog.
6. Accept the browser's native notification permission prompt.
7. The browser creates a Web Push subscription and WyNotify registers it under the workspace.
8. The new subscriber appears in **Subscribers**.
9. Send a test notification from WyNotify to confirm delivery.

### 3. Important service-worker rule

WyNotify registers its worker under a dedicated push scope so it does not replace an existing website service worker. Do not rename the file. Keep it at the website root.

### Requirements

- HTTPS is required, except for `localhost` during development.
- The visitor must explicitly opt in to notifications.
- The browser controls the final native permission prompt. WyNotify can style its own pre-permission dialog, but it cannot restyle the browser's native prompt.
- The subscriber endpoint and encryption keys are stored by WyNotify so the server can send encrypted Web Push messages to that browser.

### One-line alternative

```html
<script src="https://YOUR-WYNOTIFY-DOMAIN.com/wynotify-register.js?v=4.15.1" data-workspace-key="YOUR_PUBLIC_KEY" data-api="https://YOUR-WYNOTIFY-DOMAIN.com/api" data-label="Get updates" async></script>
```

The script creates the same subscriber button and uses the same Web Push flow.

### 1. Copy the push worker

Place `wynotify-push-sw.js` at the **root of your website**, so it is available at `/wynotify-push-sw.js`.

### 2. Add this inside your website `<head>`

```html
<meta name="wynotify-workspace-key" content="YOUR_PUBLIC_KEY">
<meta name="wynotify-api" content="https://YOUR-WYNOTIFY-DOMAIN.com/api">
<script src="https://YOUR-WYNOTIFY-DOMAIN.com/wynotify-register.js?v=4.15.1" data-label="Get updates" async></script>
```

The script creates a **Get updates** button. When a visitor clicks it, WyNotify requests notification permission, creates the browser push subscription, and registers that subscriber with your workspace. The script is safe to place inside `<head>`; it waits until the page is ready before adding the button.

### 3. Tell visitors what they are subscribing to

Use a clear message near the button, such as: **“Get updates about new products, promotions and important announcements.”** Only collect subscribers who knowingly opt in.

### Requirements

- Your website must use **HTTPS** (localhost is allowed for development).
- The service worker must be available from your website root.
- Use the exact public workspace key shown in WyNotify.
- For Android/iOS or custom applications, use the SDK/API integration instead.
- The browser's final notification permission prompt is controlled by the browser and cannot be recolored by a website. WyNotify therefore shows a branded pre-permission dialog that automatically detects the site's theme/brand color before opening the native permission prompt. You can override the detected color with `data-color="#yourcolor"` or the `wynotify-color` meta tag.

### One-line alternative

You can also skip the meta tags and use one script inside `<head>`:

```html
<script src="https://YOUR-WYNOTIFY-DOMAIN.com/wynotify-register.js?v=4.15.1" data-workspace-key="YOUR_PUBLIC_KEY" data-api="https://YOUR-WYNOTIFY-DOMAIN.com/api" data-label="Get updates" async></script>
```

The public configuration endpoint returns only the WyNotify Web Push public key. It never returns server credentials, Web Push private keys, payment secrets, or private workspace data.

## v4.15.1 patch notes (post-audit)

- **Fixed a deployment-breaking bug:** `wynotify-register.js` and `manifest.webmanifest` were sitting at the project root instead of inside `public/`. Vite only copies `public/` into the build output, so neither file would have actually existed at the live site's root in production — meaning the customer subscriber widget (`<script src=".../wynotify-register.js">`) would 404 on every website that embedded it, and the PWA manifest would 404 too. Both files have been moved into `public/`.
- **Fixed version drift risk:** the app version was previously a hand-typed literal in 8+ separate files (`package.json`, `src/firebase.js`, `src/main.jsx`, `public/wynotify-register.js`, both service workers, `api/index.js`'s health check, `public/version.json`, `index.html`). `package.json`'s `version` field is now the single source of truth — Vite's `define` injects it into the dashboard bundle, and `scripts/generate-sw.mjs` (the existing `prebuild` step) stamps it into every static file and fails the build loudly if a marker it expects to patch has gone missing, instead of silently leaving a stale version behind.
- **Backend now enforces the developer API plan gate:** the dashboard already showed "API & Webhooks" as a Pro-plan feature, but the server never actually checked plan tier before minting or accepting an API key — a Free or Starter workspace could generate and use one directly against the API, bypassing the UI. `apiKey` generation and every API-key-authenticated request now check the workspace's current plan.
- **Removed dead code:** an unused, out-of-sync duplicate of the customer subscribe flow (`registerCustomerPush` in `src/firebase.js`) and an orphaned backend action (`abTest`, superseded by `abRun` and never called from the dashboard) have been removed to reduce future drift risk.

## v4.15.1 current release

The dashboard uses hashed Vite assets plus no-store HTML/API/service-worker responses and a version manifest to prevent stale releases from remaining active after deployment.
- Plans: Free $0, Starter $5 / ₦7,500, Pro $10 / ₦15,000, Business $15 / ₦22,500.
- Subscriber count remains unlimited; plans are based on notification sends.
- Added a collapsible Features hub so advanced tools do not clutter the main dashboard.
- Added RSS feed checker, frequency controls, A/B testing workspace, working scheduled/recurring automations, statistical smart-timing view, embeddable notification inbox, subscriber tags/segments, private server API keys, and WordPress plugin.
- No email or SMS provider is included.
- No AI API is required by these features.
