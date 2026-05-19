// Nextdoor OAuth entry. Same pattern as Outlook/Ring — userId rides
// through state so the callback knows whose tokens to bind. Returns
// 500 with a clear error when NEXTDOOR_CLIENT_ID isn't set so the
// Settings row stays on "+ Connect Nextdoor" rather than triggering
// an unusable flow.

export default async function handler(req, res) {
  const clientId = process.env.NEXTDOOR_CLIENT_ID;
  if (!clientId) {
    return res.status(500).json({
      error: "NEXTDOOR_CLIENT_ID not set — Nextdoor integration is credential-gated.",
    });
  }
  const redirectUri =
    process.env.NEXTDOOR_REDIRECT_URI ||
    "https://conductor-ivory.vercel.app/api/nextdoor/callback";

  const userId = typeof req.query.userId === "string" ? req.query.userId : "";
  if (!userId) return res.status(400).json({ error: "userId required" });
  const state = JSON.stringify({ userId });

  // read:neighborhood_posts surfaces safety alerts + recommendations
  // + lost/found posts; read:local_deals adds the deal-of-the-day feed.
  // Both are needed for the brief integration described in the spec.
  const scopes = "read:neighborhood_posts read:local_deals";

  const authUrl =
    `https://auth.nextdoor.com/v2/authorize?` +
    `client_id=${encodeURIComponent(clientId)}&` +
    `response_type=code&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `scope=${encodeURIComponent(scopes)}&` +
    `state=${encodeURIComponent(state)}`;

  return res.redirect(authUrl);
}
