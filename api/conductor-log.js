// Conductor rolling log — a capped stream of the Conductor's observations,
// proactive moments, and notable actions for a household. Acts as the
// Conductor's short-term memory: ask.js loads the recent tail as context, and
// the proactive-moment generator + other surfaces append to it.
//
//   GET  /api/conductor-log?householdId={id}&limit=N   (or ?userId=)
//        -> { entries: [ newest-first ] }
//   POST /api/conductor-log  { householdId|userId, type, text, source?, urgency?, meta? }
//        -> { ok, entry }
//
// Backing store: Redis list household:{id}:conductorLog, newest-first,
// LTRIM-capped at 200 entries.

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const LOG_CAP = 200;
const parse = (v) => { try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return null; } };

// Shared append helper — importable by sync.js / brief.js / others so every
// writer goes through the same shape + cap. Best-effort: never throws.
export async function appendConductorLog(redis, householdId, entry) {
  if (!householdId || !entry) return null;
  const record = {
    id: `log_${Date.now()}_${Math.round((entry._seed ?? 0))}`,
    type: entry.type || "observation",
    text: String(entry.text || "").slice(0, 500),
    source: entry.source || "conductor",
    urgency: entry.urgency || "normal",
    meta: entry.meta && typeof entry.meta === "object" ? entry.meta : undefined,
    createdAt: entry.createdAt || Date.now(),
  };
  if (!record.text) return null;
  const key = `household:${householdId}:conductorLog`;
  try {
    await redis.lpush(key, JSON.stringify(record));
    await redis.ltrim(key, 0, LOG_CAP - 1);
    return record;
  } catch {
    return null;
  }
}

// Read the recent tail (newest-first). Reusable by ask.js.
export async function loadConductorLog(redis, householdId, limit = 50) {
  try {
    const raw = await redis.lrange(`household:${householdId}:conductorLog`, 0, Math.max(0, limit - 1));
    return (raw || []).map(parse).filter(Boolean);
  } catch {
    return [];
  }
}

async function resolveHousehold(query, body) {
  let householdId = query?.householdId || body?.householdId;
  const userId = query?.userId || body?.userId;
  if (!householdId && userId) {
    householdId = (await redis.get(`user:${userId}:household`)) || userId;
  }
  return householdId;
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    const householdId = await resolveHousehold(req.query, null);
    if (!householdId) return res.status(400).json({ error: "householdId or userId required" });
    const limit = Math.min(200, Math.max(1, parseInt(req.query?.limit, 10) || 50));
    const entries = await loadConductorLog(redis, householdId, limit);
    return res.status(200).json({ householdId, entries });
  }

  if (req.method === "POST") {
    const body = req.body || {};
    const householdId = await resolveHousehold(req.query, body);
    if (!householdId) return res.status(400).json({ error: "householdId or userId required" });
    if (!body.text || !String(body.text).trim()) {
      return res.status(400).json({ error: "text required" });
    }
    const entry = await appendConductorLog(redis, householdId, {
      type: body.type,
      text: body.text,
      source: body.source,
      urgency: body.urgency,
      meta: body.meta,
    });
    if (!entry) return res.status(500).json({ error: "failed to append" });
    return res.status(200).json({ ok: true, entry });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
