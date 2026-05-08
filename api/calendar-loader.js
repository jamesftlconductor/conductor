// Multi-driver calendar read path. Producers (api/calendar.js
// runCalendarSync, api/onboard-worker.js Job 2) write per-user keys
// at `household:{HID}:calendar:{userId}`. This loader stitches them
// back together for consumers (brief.js, notify.js, clearance.js).
//
// During the rollout, households whose sync hasn't run since the
// deploy still have their old single-key calendar at the legacy
// `household:{HID}:calendar` location. The loader falls back to that
// key when no per-user keys exist, so reads stay correct across the
// transition. The legacy key has a 30-day TTL set at write time and
// is no longer written, so it ages out naturally.

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function safeJson(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return null; }
}

// Discovers every userId currently pointing at this household. Uses
// SCAN over user:*:household rather than SMEMBERS on :members because
// the user pointer is the source of truth — the SET has had WRONGTYPE
// incidents historically and isn't always perfectly maintained.
export async function scanHouseholdMemberIds(redisClient, householdId) {
  const keys = [];
  let cursor = "0";
  do {
    const [next, batch] = await redisClient.scan(cursor, {
      match: "user:*:household",
      count: 100,
    });
    cursor = next;
    if (batch?.length) keys.push(...batch);
  } while (cursor !== "0" && cursor !== 0);

  const memberIds = [];
  for (const key of keys) {
    const userId = key.slice("user:".length, -":household".length);
    const hid = await redisClient.get(key);
    if (hid === householdId) memberIds.push(userId);
  }
  return memberIds;
}

// Merges per-user calendar keys into a single household event array.
// `memberIds` is optional — the loader will scan if not provided, but
// callers that already have the list (e.g., brief.js builds the same
// list for the household name map) can pass it to avoid a second scan.
export async function loadHouseholdCalendar(redisClient, householdId, memberIds) {
  if (!Array.isArray(memberIds)) {
    memberIds = await scanHouseholdMemberIds(redisClient, householdId);
  }

  const perUserResults = await Promise.all(
    memberIds.map((uid) =>
      redisClient.get(`household:${householdId}:calendar:${uid}`)
    )
  );

  const merged = [];
  let anyPerUser = false;
  for (const raw of perUserResults) {
    if (raw == null) continue;
    anyPerUser = true;
    const events = typeof raw === "string" ? safeJson(raw) : raw;
    if (Array.isArray(events)) merged.push(...events);
  }

  if (anyPerUser) return merged;

  // Legacy fallback — for households whose sync hasn't run since the
  // multi-driver deploy. Single-key calendar was the previous shape.
  const legacyRaw = await redisClient.get(`household:${householdId}:calendar`);
  if (legacyRaw == null) return [];
  const legacy = typeof legacyRaw === "string" ? safeJson(legacyRaw) : legacyRaw;
  return Array.isArray(legacy) ? legacy : [];
}

// Vercel deploys every .js file under api/ as a function endpoint.
// This module exists for cross-file imports only; respond 404 so a
// direct hit doesn't masquerade as a working API.
export default function handler(req, res) {
  return res.status(404).json({ error: "Not a public endpoint" });
}
