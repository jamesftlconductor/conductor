import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  const { code, error } = req.query;

  if (error) {
    return res.redirect("conductorapp://auth?error=" + error);
  }

  if (!code) {
    return res.status(400).json({ error: "No code provided" });
  }

  try {
    const redirectUri = "https://conductor-ivory.vercel.app/api/callback";

    // Exchange code for tokens
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    const tokens = await tokenResponse.json();

    if (!tokens.access_token) {
      return res.status(400).json({ error: "Failed to get tokens" });
    }

    // Get user info
    const userResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const user = await userResponse.json();

    const userId = user.email.replace(/[@.]/g, "_");

    // Store tokens with expiry tracking
    const tokenData = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + (tokens.expires_in * 1000),
      email: user.email,
      name: user.name,
      picture: user.picture,
    };

    await redis.set(`user:${userId}:tokens`, JSON.stringify(tokenData));
    await redis.set(`user:${userId}:profile`, JSON.stringify({
      email: user.email,
      name: user.name,
      picture: user.picture,
      connectedAt: Date.now(),
    }));

    // Trigger the full onboarding sweep (email + calendar + horizon) via QStash.
    // Replaces the old separate import + calendar fire-and-forgets.
    const baseUrl = "https://conductor-ivory.vercel.app";
    fetch(`${baseUrl}/api/onboard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    }).catch(err => console.error("Onboard trigger error:", err));

    // Redirect back to app immediately
    return res.redirect(
  `https://conductor-ivory.vercel.app/api/success?userId=${encodeURIComponent(userId)}&email=${encodeURIComponent(user.email)}&name=${encodeURIComponent(user.name)}`
);

  } catch (error) {
    console.error("Callback error:", error);
    return res.status(500).json({ error: "Authentication failed" });
  }
}