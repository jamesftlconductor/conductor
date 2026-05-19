// Ring OAuth callback. Exchanges code for tokens, persists at
// user:{userId}:ringTokens, redirects back into the mobile app.
//
// Same shape as the Outlook callback — userId comes from the
// state param (set by api/ring/auth.js), no household provisioning
// since Ring is always a secondary connection.

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TOKEN_URL = "https://oauth.ring.com/oauth/token";

export default async function handler(req, res) {
  const { code, error, error_description, state: stateRaw } = req.query;

  if (error) {
    return res.redirect(
      `conductorapp://auth?ringError=${encodeURIComponent(error_description || error)}`
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
    process.env.RING_REDIRECT_URI ||
    "https://conductor-ivory.vercel.app/api/ring/callback";

  try {
    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.RING_CLIENT_ID,
        client_secret: process.env.RING_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        scope: "client",
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) {
      console.error("Ring token exchange failed:", tokens);
      return res.status(400).json({ error: "Failed to get Ring tokens", detail: tokens });
    }

    const tokenData = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + ((tokens.expires_in || 3600) * 1000),
      connectedAt: Date.now(),
    };
    await redis.set(`user:${userId}:ringTokens`, JSON.stringify(tokenData));

    return res.redirect(`conductorapp://settings?ringConnected=1`);
  } catch (err) {
    console.error("Ring callback error:", err);
    return res.status(500).json({ error: "Ring authentication failed" });
  }
}
