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

- The `send` action used to cap delivery at the first 500 matched subscribers and silently drop the rest — meaning Pro (25,000) and Business (100,000) plans never actually reached their full audience on a single broadcast. Sends are now batched in groups of 500 (Firebase Cloud Messaging's hard limit per call) so every matched subscriber is reached.
- Pricing was re-checked against current USD→NGN market rates: Starter is now ₦4,500 (~$3), Pro ₦7,500 (~$5), Business ₦15,000 (~$10).

**New business-focused features**

- **Click-through tracking** (free, all plans) — every notification now records how many customers actually tapped it, shown next to sent/failed counts. Click analytics are built into WyNotify so owners can see engagement without building a separate tracking system.
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

### Public web configuration

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`
- `VITE_FIREBASE_VAPID_KEY`
- `VITE_SUPPORT_EMAIL` — optional

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

The build generates the push service worker from the configured public web variables.


## Easy website subscriber button

WyNotify includes a drop-in website integration for businesses that want visitors to subscribe without building their own notification UI. From **Subscribers**, copy the generated script and download `wynotify-push-sw.js`. The developer places the worker at the website root and pastes the script where the button should appear.

Example:

```html
<script src="https://YOUR-WYNOTIFY-DOMAIN.com/wynotify-register.js" data-workspace-key="YOUR_PUBLIC_KEY" data-api="https://YOUR-WYNOTIFY-DOMAIN.com/api" data-label="Get updates" async></script>
```

The integration requests notification permission, creates the browser subscription, and registers it to the business workspace. It requires HTTPS (or localhost for development). For custom Android/iOS apps, use the SDK/API integration instead.

Optional `<head>` configuration is also supported:

```html
<meta name="wynotify-workspace-key" content="YOUR_PUBLIC_KEY">
<meta name="wynotify-api" content="https://YOUR-WYNOTIFY-DOMAIN.com/api">
```

The public configuration endpoint returns only browser-side notification configuration. It never returns Admin SDK credentials, payment secrets, or private workspace data.
