// Ring OAuth entry. Redirects the user to Ring's authorize endpoint
// with our client_id + redirect_uri. The userId rides through `state`
// so the callback knows which Conductor user to bind tokens to.
//
// Credential-gated on RING_CLIENT_ID. Returns 500 with a clear error
// when missing — the mobile Settings row should keep showing
// "Connect Ring Doorbell" rather than triggering an unusable flow.

export default async function handler(req, res) {
  const clientId = process.env.RING_CLIENT_ID;
  if (!clientId) {
    return res.status(500).json({
      error: "RING_CLIENT_ID not set — Ring integration is credential-gated.",
    });
  }
  const redirectUri =
    process.env.RING_REDIRECT_URI ||
    "https://conductor-ivory.vercel.app/api/ring/callback";

  const userId = typeof req.query.userId === "string" ? req.query.userId : "";
  if (!userId) return res.status(400).json({ error: "userId required" });
  const state = JSON.stringify({ userId });

  const scopes = "client";

  const authUrl =
    `https://oauth.ring.com/authorize?` +
    `client_id=${encodeURIComponent(clientId)}&` +
    `response_type=code&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `scope=${encodeURIComponent(scopes)}&` +
    `state=${encodeURIComponent(state)}`;

  return res.redirect(authUrl);
}
