// Oura Ring daily sync. Reads user tokens, refreshes if expired, pulls
// readiness/sleep/activity from the v2 API, and merges into the existing
// health snapshot at user:{id}:health. Called from sync.js per-member
// (only members who have ouraTokens set), and exportable for ad-hoc
// invocation.
//
// Vercel deploys every .js under api/ as a function; this file's
// default export returns 404 so a direct HTTP hit doesn't masquerade as
// a working endpoint. Mirrors the calendar-loader convention.

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const OURA_TOKEN_URL = "https://api.ouraring.com/oauth/token";
const OURA_API_BASE = "https://api.ouraring.com/v2/usercollection";

function todayISO() {
  // Oura's date filters expect YYYY-MM-DD. Use ET local date so "today"
  // means the same day the user is reading the brief in, not whatever
  // UTC date the Vercel function happens to wake up on.
  const now = new Date();
  return now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function safeJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return null; }
}

async function refreshTokens(refreshToken) {
  if (!process.env.OURA_CLIENT_ID || !process.env.OURA_CLIENT_SECRET) {
    throw new Error("Oura integration not configured");
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: process.env.OURA_CLIENT_ID,
    client_secret: process.env.OURA_CLIENT_SECRET,
  });
  const response = await fetch(OURA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await response.json();
  if (!response.ok || !data?.access_token) {
    throw new Error(`Oura token refresh failed: ${response.status}`);
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt: Date.now() + Math.max(0, (data.expires_in ?? 3600) * 1000) - 60_000,
  };
}

async function getValidAccessToken(userId) {
  const raw = await redis.get(`user:${userId}:ouraTokens`);
  const tokens = safeJson(raw);
  if (!tokens || !tokens.accessToken) return null;
  if (tokens.expiresAt && tokens.expiresAt > Date.now()) {
    return tokens.accessToken;
  }
  if (!tokens.refreshToken) return null;
  const refreshed = await refreshTokens(tokens.refreshToken);
  await redis.set(`user:${userId}:ouraTokens`, JSON.stringify(refreshed));
  return refreshed.accessToken;
}

async function fetchOuraEndpoint(accessToken, endpoint, date) {
  const url = `${OURA_API_BASE}/${endpoint}?start_date=${date}&end_date=${date}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.warn(`[oura-sync] ${endpoint} ${response.status}: ${text.slice(0, 200)}`);
    return null;
  }
  const data = await response.json();
  // v2 always returns { data: [...] }. The day's record is the first
  // (and usually only) entry. Null when the ring hasn't synced yet.
  return Array.isArray(data?.data) && data.data.length > 0 ? data.data[0] : null;
}

function extractReadiness(r) {
  if (!r) return null;
  return {
    score: r.score ?? null,
    contributors: r.contributors ? {
      sleep_balance: r.contributors.sleep_balance ?? null,
      hrv_balance: r.contributors.hrv_balance ?? null,
      recovery_index: r.contributors.recovery_index ?? null,
      body_temperature: r.contributors.body_temperature ?? null,
    } : null,
  };
}

function extractSleep(s) {
  if (!s) return null;
  return {
    score: s.score ?? null,
    total_sleep_duration: s.total_sleep_duration ?? null,
    efficiency: s.efficiency ?? null,
    rem_sleep_duration: s.rem_sleep_duration ?? null,
    deep_sleep_duration: s.deep_sleep_duration ?? null,
    awake_time: s.awake_time ?? null,
  };
}

function extractActivity(a) {
  if (!a) return null;
  return {
    score: a.score ?? null,
    active_calories: a.active_calories ?? null,
    steps: a.steps ?? null,
    met: a.met ?? null,
  };
}

// Exported entry point. Called from sync.js per member who has tokens.
// Returns a result summary; never throws unless something catastrophic
// happens — individual endpoint failures are swallowed and surfaced as
// null fields in the merged snapshot.
export async function runOuraSync(userId) {
  if (!userId) return { skipped: "missing userId" };
  const tokensRaw = await redis.get(`user:${userId}:ouraTokens`);
  if (!tokensRaw) return { skipped: "no tokens" };

  let accessToken;
  try {
    accessToken = await getValidAccessToken(userId);
  } catch (err) {
    console.error(`[oura-sync] token acquisition failed for ${userId}:`, err?.message || err);
    return { error: "token acquisition failed", message: err?.message };
  }
  if (!accessToken) return { skipped: "no valid token" };

  const date = todayISO();
  const [readinessRaw, sleepRaw, activityRaw] = await Promise.all([
    fetchOuraEndpoint(accessToken, "daily_readiness", date),
    fetchOuraEndpoint(accessToken, "daily_sleep", date),
    fetchOuraEndpoint(accessToken, "daily_activity", date),
  ]);

  const oura = {
    readiness: extractReadiness(readinessRaw),
    sleep: extractSleep(sleepRaw),
    activity: extractActivity(activityRaw),
    syncedAt: Date.now(),
  };

  // Merge into existing health snapshot — preserve any fields written by
  // the Apple Watch HealthKit sync (sleep, hrv, restingHR, steps,
  // activeCalories) and tack the oura block on as a sibling. Brief.js
  // and the Pulse card can pick whichever source they prefer per metric.
  const existingRaw = await redis.get(`user:${userId}:health`);
  const existing = safeJson(existingRaw) || {};
  const merged = { ...existing, oura, receivedAt: Date.now() };
  await redis.set(`user:${userId}:health`, JSON.stringify(merged));

  console.log(
    `[oura-sync] ${userId}: readiness=${oura.readiness?.score ?? "null"} sleep=${oura.sleep?.score ?? "null"} activity=${oura.activity?.score ?? "null"}`
  );

  return {
    ok: true,
    readinessScore: oura.readiness?.score ?? null,
    sleepScore: oura.sleep?.score ?? null,
    activityScore: oura.activity?.score ?? null,
  };
}

// Non-public endpoint: any direct hit returns 404.
export default function handler(req, res) {
  return res.status(404).json({ error: "Not a public endpoint" });
}
