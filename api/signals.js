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

const MEMORY_TRIM_TO = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

// Append a single entry to household:{id}:memory and trim to the last
// MEMORY_TRIM_TO entries. The signal passed in should still carry the
// pre-action lastUpdate so daysInSystem reflects "how long the signal sat
// in its prior state before being acted on" — callers in PATCH must capture
// the previous value before bumping lastUpdate; the auto-expire path can
// pass the signal as-is since applyDefaultsAndExpiry doesn't touch it.
async function writeMemoryEntry(householdId, signal, action, userId) {
  let daysInSystem = null;
  if (signal && signal.lastUpdate) {
    const ms = Date.parse(signal.lastUpdate);
    if (!isNaN(ms)) {
      daysInSystem = Math.max(0, Math.round((Date.now() - ms) / DAY_MS));
    }
  }
  const entry = {
    signalId: signal?.id ?? null,
    description: signal?.description ?? null,
    type: signal?.type ?? null,
    sender: signal?.sender ?? null,
    eta: signal?.eta ?? null,
    action,
    actionAt: new Date().toISOString(),
    userId: userId || signal?.userId || null,
    source: signal?.source ?? null,
    daysInSystem,
  };
  const key = `household:${householdId}:memory`;
  await redis.lpush(key, JSON.stringify(entry));
  await redis.ltrim(key, 0, MEMORY_TRIM_TO - 1);
}

// Vault — dedicated deadline storage. GET returns items not marked handled,
// sorted by renewalDate ascending. POST handles three mobile actions:
//   add    — LPUSH a user-supplied vault item
//   handle — mark an existing item handled (hides it from active GETs)
//   delete — remove an item from the list entirely
async function handleVault(req, res) {
  const householdId = await resolveHouseholdId(req.query?.userId || req.body?.userId);
  const key = `household:${householdId}:vault`;

  if (req.method === "GET") {
    const raw = await redis.lrange(key, 0, -1);
    const items = raw
      .map(parseSignal)
      .filter(Boolean)
      .filter((v) => !v.handled);
    items.sort((a, b) => {
      const aMs = Date.parse(a.renewalDate);
      const bMs = Date.parse(b.renewalDate);
      if (isNaN(aMs)) return 1;
      if (isNaN(bMs)) return -1;
      return aMs - bMs;
    });
    return res.status(200).json({ household: householdId, count: items.length, items });
  }

  if (req.method === "POST") {
    const { action, id, item } = req.body || {};

    if (action === "add") {
      if (!item || typeof item !== "object" || !item.description) {
        return res.status(400).json({ error: "Missing item.description" });
      }
      const vaultItem = {
        id: `vault_user_${Date.now()}`,
        category: item.category || "other",
        description: item.description,
        provider: item.provider || null,
        renewalDate: item.renewalDate || null,
        amount: item.amount || null,
        consequence: item.consequence || null,
        confidence: item.confidence || "medium",
        source: "user",
        foundAt: Date.now(),
      };
      await redis.lpush(key, JSON.stringify(vaultItem));
      return res.status(200).json({ ok: true, item: vaultItem });
    }

    if (action === "handle" || action === "delete") {
      if (!id) return res.status(400).json({ error: "Missing id" });
      const raw = await redis.lrange(key, 0, -1);
      const items = raw.map(parseSignal).filter(Boolean);
      const index = items.findIndex((v) => String(v.id) === String(id));
      if (index === -1) return res.status(404).json({ error: "vault item not found" });

      if (action === "handle") {
        items[index].handled = true;
        items[index].handledAt = Date.now();
        await redis.lset(key, index, JSON.stringify(items[index]));
        return res.status(200).json({ ok: true, item: items[index] });
      }

      // delete: rewrite the list without this item.
      const remaining = items.filter((_, i) => i !== index);
      await redis.del(key);
      if (remaining.length > 0) {
        await redis.rpush(key, ...remaining.map((v) => JSON.stringify(v)));
      }
      return res.status(200).json({ ok: true, deleted: id, remaining: remaining.length });
    }

    return res.status(400).json({ error: "action must be 'add', 'handle', or 'delete'" });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed for vault" });
}

async function handleHorizon(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed for horizon" });
  }

  const householdId = await resolveHouseholdId(req.query.userId);
  const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  // Deadlines arrive in their own list with a `date` field rather than
  // `eta` (per onboard-worker's prompt). Normalize to a single `eta`
  // string so the horizon list can sort + render consistently.
  function etaMs(item) {
    const v = item.eta || item.date;
    if (!v) return NaN;
    const parsed = Date.parse(v);
    return isNaN(parsed) ? NaN : parsed;
  }

  const [{ signals }, rawDeadlines] = await Promise.all([
    loadSignals(householdId),
    redis.lrange(`household:${householdId}:deadlines`, 0, -1),
  ]);

  const farSignals = signals.filter((s) => {
    const stillOpen = !s.state || s.state === "incoming" || s.state === "active";
    if (!stillOpen) return false;
    if (s.type === "deadline") return true;
    const ms = etaMs(s);
    if (isNaN(ms)) return false;
    return ms - now > FOURTEEN_DAYS_MS;
  });

  const taggedDeadlines = (rawDeadlines || [])
    .map((item) => (typeof item === "string" ? JSON.parse(item) : item))
    .filter(Boolean)
    .filter((d) => {
      if (d.state === "resolved" || d.state === "expired") return false;
      return !isNaN(etaMs(d));
    })
    .map((d) => ({
      ...d,
      type: "deadline",
      eta: d.eta || d.date,
    }));

  // Dedupe by id — a deadline that ended up in :signals (rare, but possible
  // via hand-curation) shouldn't appear twice.
  const seen = new Set();
  const combined = [];
  for (const item of [...farSignals, ...taggedDeadlines]) {
    const id = String(item.id);
    if (seen.has(id)) continue;
    seen.add(id);
    combined.push(item);
  }

  combined.sort((a, b) => {
    const aMs = etaMs(a);
    const bMs = etaMs(b);
    if (isNaN(aMs)) return 1;
    if (isNaN(bMs)) return -1;
    return aMs - bMs;
  });

  return res.status(200).json({
    household: householdId,
    count: combined.length,
    signals: combined,
  });
}

async function handleMemory(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed for memory" });
  }
  const householdId = await resolveHouseholdId(req.query.userId);
  const limitRaw = parseInt(req.query.limit, 10);
  const limit = Math.max(1, Math.min(MEMORY_TRIM_TO, isNaN(limitRaw) ? 20 : limitRaw));
  const raw = await redis.lrange(`household:${householdId}:memory`, 0, limit - 1);
  const entries = raw.map((item) => (typeof item === "string" ? JSON.parse(item) : item));
  return res.status(200).json({ household: householdId, count: entries.length, entries });
}

// Pattern detection stub — pure aggregation over the memory log, no model
// calls. Intended as the seed for a future learning layer; the structure
// here defines the shape downstream consumers will rely on.
async function handlePatterns(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed for patterns" });
  }
  const householdId = await resolveHouseholdId(req.query.userId);
  const raw = await redis.lrange(`household:${householdId}:memory`, 0, -1);
  const entries = raw.map((item) => (typeof item === "string" ? JSON.parse(item) : item));

  const senderCounts = new Map();
  const typeBreakdown = {}; // { [type]: { resolved, held, expired } }
  const dayCounts = new Map();

  for (const e of entries) {
    if (e.sender) {
      senderCounts.set(e.sender, (senderCounts.get(e.sender) || 0) + 1);
    }
    if (e.type) {
      if (!typeBreakdown[e.type]) {
        typeBreakdown[e.type] = { resolved: 0, held: 0, expired: 0 };
      }
      if (e.action && typeBreakdown[e.type][e.action] !== undefined) {
        typeBreakdown[e.type][e.action] += 1;
      }
    }
    // Peak days are computed against actionAt (when the user / system acted
    // on the signal), since that's the timestamp every memory entry carries.
    // Useful for spotting "Sunday is when we tend to resolve things" style
    // patterns. If you need arrival-time peaks later, store importedAt on
    // signals at import time and switch this to that field.
    if (e.actionAt) {
      const d = new Date(e.actionAt);
      if (!isNaN(d.getTime())) {
        const day = d.toLocaleString("en-US", { weekday: "long" });
        dayCounts.set(day, (dayCounts.get(day) || 0) + 1);
      }
    }
  }

  const topSenders = [...senderCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([sender, count]) => ({ sender, count }));

  const peakDays = [...dayCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([day, count]) => ({ day, count }));

  return res.status(200).json({
    household: householdId,
    sampleSize: entries.length,
    topSenders,
    typeBreakdown,
    peakDays,
  });
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
  const wasNotExpired = signal.state !== "expired";
  if (!signal.state) signal.state = "incoming";

  if (signal.state !== "resolved" && signal.state !== "expired" && signal.eta) {
    const etaMs = Date.parse(signal.eta);
    if (!isNaN(etaMs) && etaMs < Date.now() - EXPIRY_MS) {
      signal.state = "expired";
      signal.expiredAt = new Date().toISOString();
    }
  }

  const changed = JSON.stringify(signal) !== original;
  const justExpired = wasNotExpired && signal.state === "expired";
  return { signal, changed, justExpired };
}

async function loadSignals(householdId) {
  const key = `household:${householdId}:signals`;
  const raw = await redis.lrange(key, 0, -1);
  const signals = raw.map(parseSignal);

  for (let i = 0; i < signals.length; i++) {
    const { signal, changed, justExpired } = applyDefaultsAndExpiry(signals[i]);
    signals[i] = signal;
    if (changed) {
      await redis.lset(key, i, JSON.stringify(signal));
    }
    if (justExpired) {
      // applyDefaultsAndExpiry doesn't touch lastUpdate, so the signal still
      // carries its prior "in system since" anchor — pass it directly.
      await writeMemoryEntry(householdId, signal, "expired", null);
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

    // Memory log — last N entries from household:{id}:memory. Useful for
    // debugging the lifecycle and as the substrate the patterns endpoint
    // aggregates over.
    if (queryType === "memory" || bodyType === "memory") {
      return handleMemory(req, res);
    }

    // Pattern detection (counting only, no model calls). Foundation of the
    // future learning layer.
    if (queryType === "patterns" || bodyType === "patterns") {
      return handlePatterns(req, res);
    }

    // Horizon — outer-ring active signals + all unresolved deadlines,
    // sorted by ETA ascending. Feeds the Horizon screen on mobile.
    if (queryType === "horizon" || bodyType === "horizon") {
      return handleHorizon(req, res);
    }

    // Vault — dedicated deadline storage with categories. GET lists active
    // (non-handled) items; POST handles add / handle / delete actions from
    // the mobile vault screen.
    if (queryType === "vault" || bodyType === "vault") {
      return handleVault(req, res);
    }

    if (req.method === "GET") {
      const householdId = await resolveHouseholdId(req.query.userId);
      const { signals } = await loadSignals(householdId);
      return res.status(200).json({ household: householdId, signals });
    }

    if (req.method === "PATCH") {
      const { id, state, userId, notedAt } = req.body || {};

      if (id === undefined || id === null) {
        return res.status(400).json({ error: "id is required" });
      }
      if (!VALID_STATES.includes(state)) {
        return res.status(400).json({ error: `state must be one of ${VALID_STATES.join(", ")}` });
      }

      const householdId = await resolveHouseholdId(userId);
      const { key, signals } = await loadSignals(householdId);

      let index = signals.findIndex(s => s.id === id || String(s.id) === String(id));

      if (index !== -1) {
        // Primary path — id is in :signals.
        const previousLastUpdate = signals[index].lastUpdate;
        signals[index].state = state;
        signals[index].lastUpdate = new Date().toLocaleString();
        if (typeof notedAt === "string" && notedAt.length > 0) {
          signals[index].notedAt = notedAt;
        }
        await redis.lset(key, index, JSON.stringify(signals[index]));

        if (state === "resolved" || state === "active") {
          const action = state === "resolved" ? "resolved" : "held";
          const memorySignal = { ...signals[index], lastUpdate: previousLastUpdate };
          await writeMemoryEntry(householdId, memorySignal, action, userId);
        }
        return res.status(200).json({ household: householdId, signal: signals[index] });
      }

      // Fallback path — id might belong to the :deadlines list, which is a
      // separate store but is exposed alongside signals on the Horizon
      // screen. Same state/notedAt + memory-log semantics apply.
      const deadlinesKey = `household:${householdId}:deadlines`;
      const rawDeadlines = await redis.lrange(deadlinesKey, 0, -1);
      const deadlines = rawDeadlines.map(parseSignal);
      index = deadlines.findIndex(d => d.id === id || String(d.id) === String(id));
      if (index === -1) {
        return res.status(404).json({ error: "signal not found" });
      }

      const previousLastUpdate = deadlines[index].lastUpdate;
      deadlines[index].state = state;
      deadlines[index].lastUpdate = new Date().toLocaleString();
      if (typeof notedAt === "string" && notedAt.length > 0) {
        deadlines[index].notedAt = notedAt;
      }
      await redis.lset(deadlinesKey, index, JSON.stringify(deadlines[index]));

      if (state === "resolved" || state === "active") {
        const action = state === "resolved" ? "resolved" : "held";
        // Tag type as "deadline" for the memory entry so the patterns
        // endpoint can see it in the typeBreakdown bucket.
        const memorySignal = {
          ...deadlines[index],
          lastUpdate: previousLastUpdate,
          type: deadlines[index].type || "deadline",
        };
        await writeMemoryEntry(householdId, memorySignal, action, userId);
      }
      return res.status(200).json({ household: householdId, signal: deadlines[index] });
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
