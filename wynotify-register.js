// WyNotify integration — drop this file into your website or app
// and call registerForNotifications(fcmToken) once you have a
// Firebase Cloud Messaging token for the current visitor/user.
//
// Your workspace registration key is already filled in below.
// Treat it like a public key: it only allows registering devices,
// nothing else.

const WYNOTIFY_ENDPOINT = "/api?action=registerDevice";
const WYNOTIFY_WORKSPACE_KEY = "";

export async function registerForNotifications(fcmToken, { subscriberType = "customers", tags = [] } = {}) {
  const res = await fetch(WYNOTIFY_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceKey: WYNOTIFY_WORKSPACE_KEY,
      token: fcmToken,
      subscriberType,
      tags,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Could not register this device for notifications.");
  return data;
}
