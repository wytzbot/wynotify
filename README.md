# WyNotify v4

WyNotify is a Firebase Cloud Messaging notification workspace with real customer-device registration, server-side delivery, Flutterwave v4 OPay billing, plan enforcement and idempotent subscription activation.

## Required Vercel environment variables

### Firebase Web (public)
- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`
- `VITE_FIREBASE_MEASUREMENT_ID` — optional
- `VITE_FIREBASE_VAPID_KEY`

### App (public)
- `VITE_SUPPORT_EMAIL` — optional support email shown by Contact Support.

### Server-only
- `FIREBASE_SERVICE_ACCOUNT_JSON` — complete Firebase Admin service-account JSON. Never prefix it with `VITE_`.
- `FLW_CLIENT_ID`
- `FLW_CLIENT_SECRET`
- `FLW_SECRET_HASH`
- `FLW_SANDBOX` — `true` while testing, `false` in production.
- `APP_URL` — deployed public URL used for payment redirects.

The build generates `public/firebase-messaging-sw.js` from the Firebase Web variables, so Firebase client configuration is not hard-coded in the source tree.

## Firebase setup

1. Enable Authentication → Sign-in method → Anonymous.
2. Enable Firestore.
3. Enable Cloud Messaging.
4. Create a Web Push certificate/VAPID key and add it to Vercel as `VITE_FIREBASE_VAPID_KEY`.
5. Keep the included Firestore rules locked down. Browser database access is intentionally disabled; the Vercel API uses Firebase Admin.
6. Deploy the required Firestore composite index (`notifications`: `workspaceId` ascending + `createdAt` descending, used by the dashboard's recent-notifications query) with `firebase deploy --only firestore:indexes`, or open the dashboard once after deploying and follow the index-creation link Firestore prints in the function logs.

## Customer notification architecture

Each owner gets a workspace with a random public registration key. Customers do **not** create WyNotify accounts.

The owner dashboard returns:
- `registration.workspaceKey`
- `registration.endpoint`

A customer-facing web app obtains its own FCM token and calls:

```js
fetch('/api?action=registerDevice', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({
    workspaceKey: 'YOUR_PUBLIC_WORKSPACE_KEY',
    token: 'CUSTOMER_FCM_TOKEN',
    subscriberType: 'customers',
    tags: ['new-users']
  })
});
```

The device is stored against the owner's workspace, not against the customer's anonymous Firebase UID.

For the owner dashboard's own browser, `registerDevice` can also be called with the authenticated Firebase token; the API automatically resolves the owner's workspace.

## Notification flow

1. Owner or customer app requests notification permission.
2. Firebase Cloud Messaging creates a registration token.
3. The token is registered against a workspace.
4. Owner calls the authenticated `send` endpoint.
5. The server loads active workspace devices and sends through Firebase Admin Messaging.
6. Invalid FCM tokens are automatically deactivated.
7. Delivery counts are stored in Firestore and shown in the dashboard.

FCM multicast is capped at 500 tokens per send in this version. The UI reports the number matched, sent and failed. For very large broadcasts, add a queue/worker before enabling bulk fan-out beyond 500 tokens.

## API

- `GET /api?action=health`
- `GET /api?action=dashboard` — authenticated workspace data and customer registration details.
- `POST /api?action=registerDevice` — public customer registration using `workspaceKey`, or authenticated owner registration.
- `POST /api?action=send` — authenticated notification delivery.
- `POST /api?action=opay` — authenticated Flutterwave v4 OPay checkout creation.
- `GET /api?action=verifyPayment&reference=...` — authenticated server-side payment verification.
- `POST /api?action=webhook` — Flutterwave webhook endpoint.

## Billing and security

The server determines the price from the selected plan. The browser cannot change a plan's amount or currency.

Subscription activation is transactionally idempotent: the same successful payment reference can never grant another month when the redirect verification and webhook arrive more than once.

Webhook HMAC verification uses the raw request body. Flutterwave charge details are verified server-side before a subscription is activated.

Plan subscriber limits are enforced server-side:

| Plan | Active subscriber limit | Analytics window |
|---|---:|---:|
| Free | 1,000 | 7 days |
| Starter | 5,000 | 30 days |
| Pro | 25,000 | 90 days |
| Business | 100,000 | 365 days |

## Data screens

- Export Data downloads the currently loaded workspace data.
- Backup downloads a portable metadata snapshot without device tokens or secrets.
- Backup validation checks the file structure before any server-side restore process.
- Search filters loaded notification history and takes the user to Notifications.

There are no fake scheduled jobs, automations, open-rate metrics or Google Drive integrations in this build. Those require a real worker/event pipeline and are deliberately not presented as working controls.

## Environment variables

Set these in Vercel → Project → Settings → Environment Variables. Public Firebase `VITE_*` values are safe to expose to the browser; Firebase Admin and Flutterwave secrets are server-only.

### Firebase Web (public)
- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`
- `VITE_FIREBASE_MEASUREMENT_ID` (optional)
- `VITE_FIREBASE_VAPID_KEY`

### App (public)
- `VITE_SUPPORT_EMAIL`

### Server-only
- `FIREBASE_SERVICE_ACCOUNT_JSON`
- `FLW_CLIENT_ID`
- `FLW_CLIENT_SECRET`
- `FLW_SECRET_HASH`
- `FLW_SANDBOX` (`true` for testing, `false` for production)
- `APP_URL`

The build generates `public/firebase-messaging-sw.js` from the Firebase Web variables so the service worker never contains a hard-coded project configuration.
