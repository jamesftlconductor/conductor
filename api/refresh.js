import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export async function getValidToken(userId) {
  const raw = await redis.get(`user:${userId}:tokens`);
  if (!raw) throw new Error("No tokens found for user");

  const tokenData = typeof raw === "string" ? JSON.parse(raw) : raw;

  // Check if token expires in less than 5 minutes
  const fiveMinutes = 5 * 60 * 1000;
  const needsRefresh = Date.now() > tokenData.expiresAt - fiveMinutes;

  if (!needsRefresh) {
    return tokenData.accessToken;
  }

  // Refresh the token
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: tokenData.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const newTokens = await response.json();

  if (!newTokens.access_token) {
    throw new Error("Failed to refresh token");
  }

  // Update stored tokens
  const updatedTokenData = {
    ...tokenData,
    accessToken: newTokens.access_token,
    expiresAt: Date.now() + (newTokens.expires_in * 1000),
  };

  await redis.set(`user:${userId}:tokens`, JSON.stringify(updatedTokenData));

  return newTokens.access_token;
}

export default async function handler(req, res) {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: "No userId provided" });
  }

  try {
    const accessToken = await getValidToken(userId);
    return res.status(200).json({ accessToken });
  } catch (error) {
    console.error("Refresh error:", error);
    return res.status(401).json({ error: "Failed to refresh token" });
  }
}