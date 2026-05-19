// Nextdoor OAuth callback. Exchanges code for tokens, persists at
// user:{userId}:nextdoorTokens, kicks off an initial scan, redirects
// back into the mobile app.
//
// userId comes from the state param. No household provisioning since
// Nextdoor is always a secondary connection.

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TOKEN_URL = "https://auth.nextdoor.com/v2/token";

// Best-effort fetch of the user's neighborhood metadata so the
// Settings row can render "✓ Nextdoor — {neighborhood name}".
// Endpoint guessed from the documented /me shape — if the response
// shape differs in practice, we just skip the neighborhood label.
async function fetchNeighborhood(accessToken) {
  try {
    const res = await fetch("https://api.nextdoor.com/v3/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.neighborhood?.name || json?.neighborhood_name || null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  const { code, error, error_description, state: stateRaw } = req.query;

  if (error) {
    return res.redirect(
      `conductorapp://auth?nextdoorError=${encodeURIComponent(error_description || error)}`
    );
  }
  if (!code) return res.status(400).json({ error: "No code provided" });

  let userId = null;
  if (stateRaw) {
    try {
      const parsed = typeof stateRaw === "string" ? JSON.parse(stateRaw) : stateRaw;
      if (parsed?.userId) userId = parsed.userId;
    } catch { /* ignore */ }
  }
  if (!userId) return res.status(400).json({ error: "userId missing from state" });

  const redirectUri =
    process.env.NEXTDOOR_REDIRECT_URI ||
    "https://conductor-ivory.vercel.app/api/nextdoor/callback";

  try {
    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.NEXTDOOR_CLIENT_ID,
        client_secret: process.env.NEXTDOOR_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) {
      console.error("Nextdoor token exchange failed:", tokens);
      return res.status(400).json({ error: "Failed to get Nextdoor tokens", detail: tokens });
    }

    const neighborhood = await fetchNeighborhood(tokens.access_token);

    const tokenData = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + ((tokens.expires_in || 3600) * 1000),
      neighborhood,
      connectedAt: Date.now(),
    };
    await redis.set(`user:${userId}:nextdoorTokens`, JSON.stringify(tokenData));

    // Fire-and-forget initial scan so the Settings row shows neighborhood
    // intelligence on the next pull-to-refresh of any consuming surface.
    const baseUrl = "https://conductor-ivory.vercel.app";
    fetch(`${baseUrl}/api/nextdoor-scan?userId=${encodeURIComponent(userId)}`, {
      method: "GET",
    }).catch((err) => console.error("Nextdoor initial scan error:", err));

    return res.redirect(`conductorapp://settings?nextdoorConnected=1`);
  } catch (err) {
    console.error("Nextdoor callback error:", err);
    return res.status(500).json({ error: "Nextdoor authentication failed" });
  }
}
