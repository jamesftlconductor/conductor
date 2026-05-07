import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const VALID_STATES = ["incoming", "active", "resolved", "expired"];
const EXPIRY_MS = 24 * 60 * 60 * 1000;

async function resolveHouseholdId(userId) {
  if (!userId) return "RangerOaks925";
  const hid = await redis.get(`user:${userId}:household`);
  return hid || "RangerOaks925";
}

function parseSignal(item) {
  return typeof item === "string" ? JSON.parse(item) : item;
}

function safeJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function handleMissedCues(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed for missedcues" });
  }

  const householdId = await resolveHouseholdId(req.query.userId);
  const { signals } = await loadSignals(householdId);

  const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;
  const now = Date.now();

  // Age in ms since the signal last meaningfully changed. lastUpdate is a
  // locale-formatted string from import.js and the PATCH handler — Date.parse
  // generally handles it. Falls back to signal.id (which is Date.now() at
  // import time) so we always have *some* timestamp to sort on.
  function ageMs(s) {
    const lastMs = s.lastUpdate ? Date.parse(s.lastUpdate) : NaN;
    if (!isNaN(lastMs)) return now - lastMs;
    if (typeof s.id === "number" && s.id > 0) return now - s.id;
    return 0;
  }

  const missed = [];
  for (const s of signals) {
    const stillOpen = !s.state || s.state === "incoming" || s.state === "active";
    if (!stillOpen) continue;
    const age = ageMs(s);
    if (s.carriedForward === true || age > FORTY_EIGHT_HOURS_MS) {
      missed.push({ ...s, _ageMs: age });
    }
  }

  // Oldest first — biggest age at the top so the list reads as "what's been
  // sitting open longest."
  missed.sort((a, b) => b._ageMs - a._ageMs);
  for (const m of missed) delete m._ageMs;

  return res.status(200).json({ household: householdId, signals: missed });
}

async function handlePreferences(req, res) {
  if (req.method === "GET") {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: "Missing userId" });
    const raw = await redis.get(`user:${userId}:preferences`);
    return res.status(200).json({ userId, preferences: safeJson(raw) || {} });
  }

  if (req.method === "POST") {
    const { userId, preferences, expoPushToken, healthData } = req.body || {};
    if (!userId || typeof userId !== "string") {
      return res.status(400).json({ error: "Missing or invalid userId" });
    }
    if (preferences === undefined && expoPushToken === undefined && healthData === undefined) {
      return res.status(400).json({ error: "Provide preferences, expoPushToken, and/or healthData" });
    }
    if (preferences !== undefined && (preferences === null || typeof preferences !== "object")) {
      return res.status(400).json({ error: "Invalid preferences" });
    }
    if (expoPushToken !== undefined && typeof expoPushToken !== "string") {
      return res.status(400).json({ error: "Invalid expoPushToken" });
    }
    if (healthData !== undefined && (healthData === null || typeof healthData !== "object")) {
      return res.status(400).json({ error: "Invalid healthData" });
    }
    if (preferences !== undefined) {
      // Shallow-merge into existing prefs so a partial update (settings-screen
      // toggle, diagnostic marker) doesn't nuke unrelated keys. Callers that
      // genuinely want a full replacement can fetch first and send the full
      // merged object themselves.
      const existingRaw = await redis.get(`user:${userId}:preferences`);
      const existing = safeJson(existingRaw) || {};
      const merged = { ...existing, ...preferences };
      await redis.set(`user:${userId}:preferences`, JSON.stringify(merged));
    }
    if (typeof expoPushToken === "string" && expoPushToken.length > 0) {
      await redis.set(`user:${userId}:expoPushToken`, expoPushToken);
    }
    if (healthData !== undefined) {
      // Stamp receipt so brief.js can decide whether the snapshot is stale.
      const stamped = { ...healthData, receivedAt: Date.now() };
      await redis.set(`user:${userId}:health`, JSON.stringify(stamped));
    }
    return res.status(200).json({ ok: true, userId });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed for preferences" });
}

function applyDefaultsAndExpiry(signal) {
  const original = JSON.stringify(signal);
  if (!signal.state) signal.state = "incoming";

  if (signal.state !== "resolved" && signal.state !== "expired" && signal.eta) {
    const etaMs = Date.parse(signal.eta);
    if (!isNaN(etaMs) && etaMs < Date.now() - EXPIRY_MS) {
      signal.state = "expired";
      signal.expiredAt = new Date().toISOString();
    }
  }

  return { signal, changed: JSON.stringify(signal) !== original };
}

async function loadSignals(householdId) {
  const key = `household:${householdId}:signals`;
  const raw = await redis.lrange(key, 0, -1);
  const signals = raw.map(parseSignal);

  for (let i = 0; i < signals.length; i++) {
    const { signal, changed } = applyDefaultsAndExpiry(signals[i]);
    signals[i] = signal;
    if (changed) {
      await redis.lset(key, i, JSON.stringify(signal));
    }
  }

  return { key, signals };
}

export default async function handler(req, res) {
  try {
    // Side branch: preferences read/write (folded in to stay under Hobby plan's
    // 12-function limit). Triggered by ?type=preferences on GET or POST.
    const queryType = req.query?.type;
    const bodyType = req.body?.type;
    if (queryType === "preferences" || bodyType === "preferences") {
      return handlePreferences(req, res);
    }

    // Missed cues — feeds the future Missed Cues screen. Returns active
    // signals where carriedForward is set OR they've sat unchanged > 48h.
    if (queryType === "missedcues" || bodyType === "missedcues") {
      return handleMissedCues(req, res);
    }

    if (req.method === "GET") {
      const householdId = await resolveHouseholdId(req.query.userId);
      const { signals } = await loadSignals(householdId);
      return res.status(200).json({ household: householdId, signals });
    }

    if (req.method === "PATCH") {
      const { id, state, userId } = req.body || {};

      if (id === undefined || id === null) {
        return res.status(400).json({ error: "id is required" });
      }
      if (!VALID_STATES.includes(state)) {
        return res.status(400).json({ error: `state must be one of ${VALID_STATES.join(", ")}` });
      }

      const householdId = await resolveHouseholdId(userId);
      const { key, signals } = await loadSignals(householdId);

      const index = signals.findIndex(s => s.id === id || String(s.id) === String(id));
      if (index === -1) {
        return res.status(404).json({ error: "signal not found" });
      }

      signals[index].state = state;
      signals[index].lastUpdate = new Date().toLocaleString();
      await redis.lset(key, index, JSON.stringify(signals[index]));

      return res.status(200).json({ household: householdId, signal: signals[index] });
    }

    if (req.method === "DELETE") {
      const { id, userId } = req.body || {};
      if (id === undefined || id === null) {
        return res.status(400).json({ error: "id is required" });
      }

      const householdId = await resolveHouseholdId(userId);
      const key = `household:${householdId}:signals`;
      const raw = await redis.lrange(key, 0, -1);
      const signals = raw.map(parseSignal);
      const remaining = signals.filter(
        s => s.id !== id && String(s.id) !== String(id)
      );

      if (remaining.length === signals.length) {
        return res.status(404).json({ error: "signal not found" });
      }

      // Replace the list atomically — del + rpush each remaining entry.
      await redis.del(key);
      for (const s of remaining) {
        await redis.rpush(key, JSON.stringify(s));
      }

      return res.status(200).json({ household: householdId, deleted: id, remaining: remaining.length });
    }

    res.setHeader("Allow", "GET, PATCH, DELETE");
    return res.status(405).json({ error: "Method not allowed" });

  } catch (error) {
    console.error("Signals error:", error);
    return res.status(500).json({ error: "Signals request failed" });
  }
}
