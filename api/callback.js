import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Builds a friendly household id like "SarahHome4821" from the user's
// Google profile name (falling back to the email local-part if name is
// missing). The 4-digit suffix randomizes per-call so two users with the
// same first name don't collide on first auth.
function buildHouseholdId(name, email) {
  const fallback = (email || "user").split("@")[0].split(/[._-]/)[0] || "user";
  const firstToken = (name || "").split(/\s+/)[0] || "";
  const cleaned = (firstToken || fallback).replace(/[^a-zA-Z0-9]/g, "");
  const base = cleaned || "user";
  const capped = base.charAt(0).toUpperCase() + base.slice(1);
  const digits = Math.floor(1000 + Math.random() * 9000);
  return `${capped}Home${digits}`;
}

// Try a few candidates so the random suffix doesn't collide with an
// already-claimed household. Five tries is overkill for a 4-digit space
// at current scale but cheap insurance.
async function reserveHouseholdId(name, email) {
  for (let i = 0; i < 5; i++) {
    const candidate = buildHouseholdId(name, email);
    const taken = await redis.exists(`household:${candidate}:name`);
    if (!taken) return candidate;
  }
  return `${buildHouseholdId(name, email)}_${Date.now().toString(36)}`;
}

export default async function handler(req, res) {
  const { code, error, state: stateRaw } = req.query;

  if (error) {
    return res.redirect("conductormobile://auth?error=" + error);
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

    // Resolve the user's household. Three branches:
    //  - just-joined-via-invite: invite block above already wrote
    //    user:{id}:household and added them to :members
    //  - returning user: pointer already exists, leave as-is
    //  - first-time, no invite: auto-provision a private household so
    //    their onboard pipeline has somewhere to write. Without this,
    //    new sign-ups land on whatever default household existed (or
    //    none) and their first Takeoff is empty or wrong.
    let resolvedHouseholdId = joinedHouseholdId;
    let mode = joinedHouseholdId ? "join" : null;
    if (!resolvedHouseholdId) {
      const existingHousehold = await redis.get(`user:${userId}:household`);
      if (existingHousehold) {
        resolvedHouseholdId = existingHousehold;
        mode = "existing";
      } else {
        const newHouseholdId = await reserveHouseholdId(user.name, user.email);
        await redis.set(`user:${userId}:household`, newHouseholdId);
        // :members is a Redis SET everywhere else (SADD/SMEMBERS); using
        // redis.set with a JSON string would break the invite-join SADD
        // path, which already has a defensive WRONGTYPE recovery.
        await redis.sadd(`household:${newHouseholdId}:members`, userId);
        await redis.set(`household:${newHouseholdId}:firstRun`, "true");
        await redis.set(`household:${newHouseholdId}:name`, newHouseholdId);
        resolvedHouseholdId = newHouseholdId;
        mode = "create";
      }
    }

    // Auto-populate the household crew with a member record for this
    // user. Idempotent — if a record with the same userId already
    // exists, we leave it alone (preserving any birthday/anniversary
    // edits made via the Crew screen's Edit modal). Wrapped in try/
    // catch so a crew-write failure doesn't break the auth flow.
    try {
      const crewKey = `household:${resolvedHouseholdId}:crew`;
      const crewRaw = await redis.get(crewKey);
      const crew = (() => {
        if (!crewRaw) return [];
        try {
          const parsed = typeof crewRaw === "string" ? JSON.parse(crewRaw) : crewRaw;
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })();
      const alreadyMember = crew.some(
        (m) => m && m.memberType === "member" && m.userId === userId
      );
      if (!alreadyMember) {
        const firstName = (user.name || "").split(/\s+/)[0] || "";
        crew.push({
          memberType: "member",
          userId,
          name: firstName,
          fullName: user.name || null,
          picture: user.picture || null,
          email: user.email,
          joinedAt: new Date().toISOString(),
          birthday: null,
          anniversary: null,
        });
        await redis.set(crewKey, JSON.stringify(crew));
        console.log(`[callback] added crew member record for ${userId} in ${resolvedHouseholdId}`);
      }
    } catch (crewErr) {
      console.warn(`[callback] crew auto-populate failed:`, crewErr?.message || crewErr);
    }

    // Trigger the full onboarding sweep (email + calendar + horizon) via QStash.
    // Runs for every sign-in path — invite-join, new-create, and returning
    // — since /api/onboard reads user:{id}:household at execution time and
    // is idempotent (dedup keys on contentFingerprints + importedMessages).
    const baseUrl = "https://conductor-ivory.vercel.app";
    fetch(`${baseUrl}/api/onboard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    }).catch(err => console.error("Onboard trigger error:", err));

    // Redirect back to app — pass householdId + mode so the success page
    // renders the right welcome copy ("joined", "welcome to", "welcome back").
    const successParams = new URLSearchParams({
      userId,
      email: user.email,
      name: user.name,
    });
    if (resolvedHouseholdId) successParams.set("householdId", resolvedHouseholdId);
    if (mode) successParams.set("mode", mode);
    return res.redirect(`${baseUrl}/api/success?${successParams.toString()}`);

  } catch (error) {
    console.error("Callback error:", error);
    return res.status(500).json({ error: "Authentication failed" });
  }
}