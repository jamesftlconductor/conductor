import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  const { code, error, state: stateRaw } = req.query;

  if (error) {
    return res.redirect("conductorapp://auth?error=" + error);
  }

  if (!code) {
    return res.status(400).json({ error: "No code provided" });
  }

  // Recover any invite code that was forwarded through the OAuth state param
  // by /api/auth. JSON-parsed defensively — bad state shouldn't block sign-in.
  let inviteCode = null;
  if (stateRaw) {
    try {
      const parsed = typeof stateRaw === "string" ? JSON.parse(stateRaw) : stateRaw;
      if (parsed && typeof parsed.inviteCode === "string" && parsed.inviteCode.length > 0) {
        inviteCode = parsed.inviteCode;
      }
    } catch {
      // ignored — proceed without invite consumption
    }
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

    // Consume the invite (if any) — tied to user.email's userId, before we
    // kick off onboarding so the user's household is set when imports start
    // writing into household:{id}:signals.
    let joinedHouseholdId = null;
    if (inviteCode) {
      const inviteRaw = await redis.get(`invite:${inviteCode}`);
      const invite = typeof inviteRaw === "string" ? JSON.parse(inviteRaw) : inviteRaw;
      const stillValid =
        invite && (!invite.expiresAt || Date.now() <= invite.expiresAt);
      if (stillValid) {
        await redis.set(`user:${userId}:household`, invite.householdId);
        const membersKey = `household:${invite.householdId}:members`;
        try {
          await redis.sadd(membersKey, userId);
        } catch (sErr) {
          // Defensive: if some prior write left :members as a non-SET type
          // (string, list, etc.), SADD throws WRONGTYPE. Delete and recreate
          // as a fresh SET so the join still completes. Without this, an
          // accidental write upstream would permanently break new joins.
          if (String(sErr?.message || "").includes("WRONGTYPE")) {
            console.warn(`Members key ${membersKey} had wrong type; resetting to SET`);
            await redis.del(membersKey);
            await redis.sadd(membersKey, userId);
          } else {
            throw sErr;
          }
        }
        // Single-use semantics — deleting prevents re-joins or sharing the
        // link beyond the first redemption.
        await redis.del(`invite:${inviteCode}`);
        joinedHouseholdId = invite.householdId;
      }
    }

    // Trigger the full onboarding sweep (email + calendar + horizon) via QStash.
    // Replaces the old separate import + calendar fire-and-forgets.
    const baseUrl = "https://conductor-ivory.vercel.app";
    fetch(`${baseUrl}/api/onboard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    }).catch(err => console.error("Onboard trigger error:", err));

    // Redirect back to app — append householdId when the user joined via
    // invite so the success page can render the right copy.
    const successParams = new URLSearchParams({
      userId,
      email: user.email,
      name: user.name,
    });
    if (joinedHouseholdId) successParams.set("householdId", joinedHouseholdId);
    return res.redirect(`${baseUrl}/api/success?${successParams.toString()}`);

  } catch (error) {
    console.error("Callback error:", error);
    return res.status(500).json({ error: "Authentication failed" });
  }
}