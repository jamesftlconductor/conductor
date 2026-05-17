import { Redis } from "@upstash/redis";
import { loadHouseholdCalendar } from "./calendar-loader.js";
import { detectOrLoadLocation, saveHouseholdLocation, loadHouseholdLocation } from "./location.js";

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
// ---------- caught moments ----------
//
// When a signal/deadline is Rested close to its ETA/renewal, log a
// "caught moment" — these surface warmly at the end of the clearance
// brief and in the Sunday Week in Review. Three criteria:
//   - Vault item handled within 72h of renewalDate
//   - Signal rested within 48h of its ETA (in either direction —
//     pre-deadline catch or just-past-deadline catch)
//   - Conflict resolved (skipped in v1; needs pair tracking)
const CAUGHT_MOMENTS_KEY_SUFFIX = ":caughtMoments";
const CAUGHT_MOMENTS_CAP = 100;

function detectCaughtMoment(item, opts = {}) {
  // opts.kind: "signal" | "deadline" | "vault"
  // Returns { type, daysBeforeExpiry } when criterion matches, else null.
  if (!item) return null;
  const now = Date.now();
  const HOURS_72 = 72 * 60 * 60 * 1000;
  const HOURS_48 = 48 * 60 * 60 * 1000;

  if (opts.kind === "vault") {
    const renewalMs = item.renewalDate ? Date.parse(item.renewalDate) : NaN;
    if (isNaN(renewalMs)) return null;
    const delta = renewalMs - now;
    // Within 72h ahead of or 24h past renewal counts as a close call.
    if (delta > -24 * 60 * 60 * 1000 && delta < HOURS_72) {
      const daysBefore = Math.max(0, Math.round(delta / (24 * 60 * 60 * 1000)));
      return { type: "deadline_close_call", daysBeforeExpiry: daysBefore };
    }
    return null;
  }

  // signal or deadline — look at ETA
  const etaMs = item.eta ? Date.parse(item.eta) : NaN;
  if (isNaN(etaMs)) return null;
  const delta = etaMs - now;
  if (Math.abs(delta) > HOURS_48) return null;
  // Type tag: vault-deadline items typed "deadline" carry close-call;
  // delivery/package types are "last-minute" framings.
  const cmType =
    item.type === "deadline" ? "deadline_close_call"
    : (item.type === "delivery" || item.type === "package") ? "delivery_last_minute"
    : "deadline_close_call";
  const daysBefore = Math.max(0, Math.round(delta / (24 * 60 * 60 * 1000)));
  return { type: cmType, daysBeforeExpiry: daysBefore };
}

async function recordCaughtMoment(householdId, item, criterion, userId) {
  const key = `household:${householdId}${CAUGHT_MOMENTS_KEY_SUFFIX}`;
  const record = {
    id: Date.now(),
    type: criterion.type,
    description: item.description || "Unknown",
    sender: item.sender || item.provider || null,
    resolvedAt: new Date().toISOString(),
    daysBeforeExpiry: criterion.daysBeforeExpiry,
    userId: userId || null,
  };
  await redis.lpush(key, JSON.stringify(record));
  await redis.ltrim(key, 0, CAUGHT_MOMENTS_CAP - 1);
  console.log(
    `[caught] ${criterion.type}: ${record.description} (${record.daysBeforeExpiry}d before)`
  );
}

// Export for clearance.js to read the last-7-days slice.
export async function loadRecentCaughtMoments(householdId, days = 7) {
  const raw = await redis.lrange(`household:${householdId}${CAUGHT_MOMENTS_KEY_SUFFIX}`, 0, -1);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const out = [];
  for (const r of raw || []) {
    try {
      const parsed = JSON.parse(r);
      const ms = parsed.resolvedAt ? Date.parse(parsed.resolvedAt) : NaN;
      if (!isNaN(ms) && ms >= cutoff) out.push(parsed);
    } catch { /* skip */ }
  }
  return out;
}

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

// Compass — longitudinal aggregation over the memory log + patterns list.
// Richer cousin of ?type=patterns: adds first-seen / last-seen timestamps,
// resolution speed in hours, most-active and quietest day-of-week.
async function handleCompass(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed for compass" });
  }

  const householdId = await resolveHouseholdId(req.query?.userId);
  const [rawMemory, rawPatterns] = await Promise.all([
    redis.lrange(`household:${householdId}:memory`, 0, -1),
    redis.lrange(`household:${householdId}:patterns`, 0, -1),
  ]);
  const entries = rawMemory.map((x) => (typeof x === "string" ? JSON.parse(x) : x)).filter(Boolean);
  const patterns = rawPatterns.map((x) => (typeof x === "string" ? JSON.parse(x) : x)).filter(Boolean);

  const now = Date.now();
  const DAY_MS_LOCAL = 24 * 60 * 60 * 1000;

  // Aggregations in a single pass over memory.
  const senderMap = new Map(); // sender -> { count, lastSeenMs }
  const typeBreakdown = {};    // { [type]: { resolved, held, expired } }
  const dayCounts = new Map(); // day-of-week -> count
  const typeTotals = new Map();// type -> total count
  let totalResolved = 0;
  let earliestActionMs = Infinity;
  let resolutionDaysSum = 0;
  let resolutionDaysCount = 0;

  // Initialise day buckets at zero so quietestDay can return a real day even
  // when a slot has zero entries. Keeps Mon-Sun ordering for downstream.
  const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  for (const d of DAYS) dayCounts.set(d, 0);

  for (const e of entries) {
    if (e.action === "resolved") totalResolved += 1;

    const actionMs = e.actionAt ? Date.parse(e.actionAt) : NaN;
    if (!isNaN(actionMs)) {
      if (actionMs < earliestActionMs) earliestActionMs = actionMs;
      const day = new Date(actionMs).toLocaleString("en-US", { weekday: "long" });
      dayCounts.set(day, (dayCounts.get(day) || 0) + 1);
    }

    if (e.sender) {
      const cur = senderMap.get(e.sender) || { count: 0, lastSeenMs: 0 };
      cur.count += 1;
      if (!isNaN(actionMs) && actionMs > cur.lastSeenMs) cur.lastSeenMs = actionMs;
      senderMap.set(e.sender, cur);
    }

    if (e.type) {
      if (!typeBreakdown[e.type]) typeBreakdown[e.type] = { resolved: 0, held: 0, expired: 0 };
      if (e.action && typeBreakdown[e.type][e.action] !== undefined) {
        typeBreakdown[e.type][e.action] += 1;
      }
      typeTotals.set(e.type, (typeTotals.get(e.type) || 0) + 1);
    }

    if (e.action === "resolved" && typeof e.daysInSystem === "number" && e.daysInSystem >= 0) {
      resolutionDaysSum += e.daysInSystem;
      resolutionDaysCount += 1;
    }
  }

  const daysSinceFirst = isFinite(earliestActionMs)
    ? Math.max(0, Math.round((now - earliestActionMs) / DAY_MS_LOCAL))
    : 0;
  const householdAge = daysSinceFirst; // alias — distinct conceptually, identical in practice

  const topSenders = [...senderMap.entries()]
    .map(([sender, v]) => ({
      sender,
      count: v.count,
      lastSeen: v.lastSeenMs ? new Date(v.lastSeenMs).toISOString() : null,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const peakDays = DAYS.map((d) => ({ day: d, count: dayCounts.get(d) || 0 }))
    .sort((a, b) => b.count - a.count);

  const mostActiveCategoryEntry = [...typeTotals.entries()].sort((a, b) => b[1] - a[1])[0];
  const mostActiveCategory = mostActiveCategoryEntry ? mostActiveCategoryEntry[0] : null;

  // quietestDay — only defined when we have at least one memory entry
  // (otherwise every day is equally zero, which isn't a meaningful answer).
  const quietestDay = entries.length > 0
    ? DAYS.slice().sort((a, b) => (dayCounts.get(a) || 0) - (dayCounts.get(b) || 0))[0]
    : null;

  // Average resolution time in hours, computed from daysInSystem on resolved
  // entries. daysInSystem is integer-rounded; multiplying by 24 still gives
  // a reasonable order-of-magnitude.
  const averageResolutionTime = resolutionDaysCount > 0
    ? +(resolutionDaysSum / resolutionDaysCount * 24).toFixed(1)
    : null;

  return res.status(200).json({
    household: householdId,
    sampleSize: entries.length,
    patternsCount: patterns.length,
    totalResolved,
    daysSinceFirst,
    householdAge,
    topSenders,
    typeBreakdown,
    peakDays,
    averageResolutionTime,
    mostActiveCategory,
    quietestDay,
  });
}

// Vault — dedicated deadline storage. GET returns items not marked handled,
// sorted by renewalDate ascending. POST handles three mobile actions:
//   add    — LPUSH a user-supplied vault item
//   handle — mark an existing item handled (hides it from active GETs)
//   delete — remove an item from the list entirely
// Crew — children + pets layer. The single household:{id}:crew key
// holds a JSON-stringified array of member records written by the
// onboard worker's Crew job. GET parses and returns it; missing key
// returns an empty array so the mobile screen renders an empty state
// rather than erroring.
async function handleCrew(req, res) {
  if (req.method === "GET") {
    const householdId = await resolveHouseholdId(req.query?.userId);
    const raw = await redis.get(`household:${householdId}:crew`);
    let crew = [];
    if (raw != null) {
      try {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (Array.isArray(parsed)) crew = parsed;
      } catch {
        // malformed payload — return empty rather than 500
      }
    }
    return res.status(200).json({ household: householdId, crew });
  }

  if (req.method === "POST") {
    // Edit modal: update birthday/anniversary on an existing crew
    // member. Two routing paths mirror the onboard worker's birthday
    // pass:
    //   A) household-member edit (targetUserId provided) → write to
    //      user:{targetUserId}:profile so the brief picks it up via the
    //      profile loop, AND mirror onto the crew member record for
    //      consistency with the Crew screen UI
    //   B) child/pet/extended edit (memberType + name) → update the
    //      crew member record directly
    const { userId, targetUserId, memberType, name, birthday, anniversary } = req.body || {};
    if (!userId) return res.status(400).json({ error: "Missing userId" });

    // Light input validation. Either targetUserId (path A) OR
    // memberType+name (path B) must be present so we know who to edit.
    if (!targetUserId && !(memberType && name)) {
      return res.status(400).json({
        error: "Provide targetUserId (for a household member) or memberType+name (for a child/pet/extended record)",
      });
    }
    if (birthday !== undefined && birthday !== null && !/^\d{2}-\d{2}$/.test(birthday)) {
      return res.status(400).json({ error: "birthday must be MM-DD format or null" });
    }
    if (anniversary !== undefined && anniversary !== null && !/^\d{2}-\d{2}$/.test(anniversary)) {
      return res.status(400).json({ error: "anniversary must be MM-DD format or null" });
    }

    const householdId = await resolveHouseholdId(userId);

    // Path A: household member — write profile, then mirror in crew
    if (targetUserId) {
      try {
        const rawProfile = await redis.get(`user:${targetUserId}:profile`);
        const profile =
          typeof rawProfile === "string" ? JSON.parse(rawProfile) : (rawProfile || {});
        if (birthday !== undefined) profile.birthday = birthday;
        if (anniversary !== undefined) profile.anniversary = anniversary;
        await redis.set(`user:${targetUserId}:profile`, JSON.stringify(profile));
      } catch (err) {
        return res.status(500).json({ error: "Profile update failed", message: err.message });
      }
    }

    // Mirror into the crew member record (both for household members
    // and for child/pet/extended records). Single source of truth from
    // the Crew screen's perspective.
    const crewKey = `household:${householdId}:crew`;
    const rawCrew = await redis.get(crewKey);
    const crew = (() => {
      if (!rawCrew) return [];
      try {
        const parsed = typeof rawCrew === "string" ? JSON.parse(rawCrew) : rawCrew;
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    })();

    let updatedIndex = -1;
    for (let i = 0; i < crew.length; i++) {
      const m = crew[i];
      if (!m) continue;
      if (targetUserId) {
        if (m.memberType === "member" && m.userId === targetUserId) {
          updatedIndex = i;
          break;
        }
      } else if (memberType && name) {
        if (
          m.memberType === memberType &&
          (m.name || "").toLowerCase().trim() === name.toLowerCase().trim()
        ) {
          updatedIndex = i;
          break;
        }
      }
    }

    if (updatedIndex >= 0) {
      if (birthday !== undefined) crew[updatedIndex].birthday = birthday;
      if (anniversary !== undefined) crew[updatedIndex].anniversary = anniversary;
      await redis.set(crewKey, JSON.stringify(crew));
    } else {
      return res.status(404).json({ error: "Crew member not found" });
    }

    return res.status(200).json({ ok: true, householdId, member: crew[updatedIndex] });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed for crew" });
}

async function handleVault(req, res) {
  const householdId = await resolveHouseholdId(req.query?.userId || req.body?.userId);
  const key = `household:${householdId}:vault`;

  if (req.method === "GET") {
    const raw = await redis.lrange(key, 0, -1);
    let items = raw
      .map(parseSignal)
      .filter(Boolean)
      .filter((v) => !v.handled);

    // Optional search — case-insensitive substring across description,
    // provider, category, and notes.
    const search = (req.query?.search || "").toString().trim().toLowerCase();
    if (search.length > 0) {
      items = items.filter((v) => {
        const haystack = [
          v.description, v.provider, v.category, v.notes, v.agentName,
        ].filter(Boolean).join(" ").toLowerCase();
        return haystack.includes(search);
      });
    }

    // Sort key: "urgency" (default; soonest renewal first), "category"
    // (alphabetical), "amount" (numeric desc), "added" (newest first by
    // createdAt / foundAt timestamp).
    const sort = (req.query?.sort || "urgency").toString();
    const parseAmount = (v) => {
      if (typeof v?.amount === "number") return v.amount;
      if (typeof v?.amount === "string") {
        const m = v.amount.match(/[\d.]+/);
        return m ? parseFloat(m[0]) : 0;
      }
      return 0;
    };
    if (sort === "category") {
      items.sort((a, b) => (a.category || "").localeCompare(b.category || ""));
    } else if (sort === "amount") {
      items.sort((a, b) => parseAmount(b) - parseAmount(a));
    } else if (sort === "added") {
      items.sort((a, b) => {
        const at = Date.parse(a.createdAt) || a.foundAt || 0;
        const bt = Date.parse(b.createdAt) || b.foundAt || 0;
        return (bt || 0) - (at || 0);
      });
    } else {
      // urgency / default
      items.sort((a, b) => {
        const aMs = Date.parse(a.renewalDate);
        const bMs = Date.parse(b.renewalDate);
        if (isNaN(aMs)) return 1;
        if (isNaN(bMs)) return -1;
        return aMs - bMs;
      });
    }

    return res.status(200).json({ household: householdId, count: items.length, items });
  }

  if (req.method === "POST") {
    const { action, id, item } = req.body || {};

    if (action === "add") {
      if (!item || typeof item !== "object" || !item.description) {
        return res.status(400).json({ error: "Missing item.description" });
      }
      // Extended schema: contactPhone, contactEmail, agentName, notes,
      // reminderDate, policyNumber, priceHistory all default to null/
      // empty so the new UI's inline-edit affordances always have a
      // place to write into.
      const vaultItem = {
        id: `vault_user_${Date.now()}`,
        category: item.category || "other",
        description: item.description,
        provider: item.provider || null,
        renewalDate: item.renewalDate || null,
        amount: item.amount || null,
        consequence: item.consequence || null,
        confidence: item.confidence || "medium",
        source: item.source || "manual",
        policyNumber: item.policyNumber || null,
        contactPhone: item.contactPhone || null,
        contactEmail: item.contactEmail || null,
        agentName: item.agentName || null,
        notes: item.notes || null,
        reminderDate: item.reminderDate || null,
        priceHistory: [],
        handled: false,
        foundAt: Date.now(),
        createdAt: new Date().toISOString(),
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
        // Caught moment — vault items handled within 72h of their
        // renewalDate. Same warm-acknowledgment surface as PATCH-side
        // signal/deadline resolution.
        const criterion = detectCaughtMoment(items[index], { kind: "vault" });
        if (criterion) await recordCaughtMoment(householdId, items[index], criterion, req.body?.userId);
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

  // PATCH — merge enrichment fields onto an existing vault item.
  // Body: { itemId, updates: { policyNumber, notes, contactPhone,
  // contactEmail, agentName, reminderDate, description, provider,
  // renewalDate, amount } }. Whitelisted keys only so accidental
  // payloads can't overwrite source / handled / priceHistory.
  if (req.method === "PATCH") {
    const { itemId, updates } = req.body || {};
    if (!itemId) return res.status(400).json({ error: "itemId required" });
    if (!updates || typeof updates !== "object") {
      return res.status(400).json({ error: "updates object required" });
    }
    const raw = await redis.lrange(key, 0, -1);
    const items = raw.map(parseSignal).filter(Boolean);
    const index = items.findIndex((v) => String(v.id) === String(itemId));
    if (index === -1) return res.status(404).json({ error: "vault item not found" });

    const ALLOWED = new Set([
      "policyNumber", "notes", "contactPhone", "contactEmail", "agentName",
      "reminderDate", "description", "provider", "renewalDate", "amount",
      "category", "consequence",
    ]);
    const merged = { ...items[index] };
    for (const [k, v] of Object.entries(updates)) {
      if (!ALLOWED.has(k)) continue;
      merged[k] = v === "" ? null : v;
    }
    merged.lastUpdate = new Date().toLocaleString();
    await redis.lset(key, index, JSON.stringify(merged));
    return res.status(200).json({ ok: true, item: merged });
  }

  res.setHeader("Allow", "GET, POST, PATCH");
  return res.status(405).json({ error: "Method not allowed for vault" });
}

// Calendar — read-only view of the merged household calendar. Used by
// the Programme screen to assemble its 14-day timeline. The mobile app
// gets the same event shape brief.js consumes (id / title / start / end
// / type / householdRelevant), with work events already privacy-stripped
// to time-block-only fields by the upstream sync.
async function handleCalendarRead(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed for calendar" });
  }
  const householdId = await resolveHouseholdId(req.query.userId);
  const events = await loadHouseholdCalendar(redis, householdId);
  return res.status(200).json({ household: householdId, events });
}

async function handleHorizon(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed for horizon" });
  }

  const householdId = await resolveHouseholdId(req.query.userId);
  const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  // Vault items use `renewalDate`, signals use `eta`, legacy deadline
  // records used `date` — normalize to a single ms timestamp for filtering
  // and sorting. (Legacy `date` kept in case any pre-vault entries leak
  // through somehow; new code only writes `renewalDate` or `eta`.)
  function etaMs(item) {
    const v = item.eta || item.renewalDate || item.date;
    if (!v) return NaN;
    const parsed = Date.parse(v);
    return isNaN(parsed) ? NaN : parsed;
  }

  const [{ signals }, rawVault] = await Promise.all([
    loadSignals(householdId),
    redis.lrange(`household:${householdId}:vault`, 0, -1),
  ]);

  const farSignals = signals.filter((s) => {
    const stillOpen = !s.state || s.state === "incoming" || s.state === "active";
    if (!stillOpen) return false;
    if (s.type === "deadline") return true;
    const ms = etaMs(s);
    if (isNaN(ms)) return false;
    return ms - now > FOURTEEN_DAYS_MS;
  });

  const taggedDeadlines = (rawVault || [])
    .map((item) => (typeof item === "string" ? JSON.parse(item) : item))
    .filter(Boolean)
    .filter((v) => {
      if (v.handled) return false;
      if (v.state === "resolved" || v.state === "expired") return false;
      return !isNaN(etaMs(v));
    })
    .map((v) => ({
      ...v,
      type: "deadline",
      eta: v.renewalDate || v.eta,
    }));

  // Dedupe by id — a vault item that ended up in :signals (rare) shouldn't
  // appear twice.
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

async function handleHealthRead(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed for health" });
  }
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "Missing userId" });
  const raw = await redis.get(`user:${userId}:health`);
  return res.status(200).json({ userId, health: safeJson(raw) });
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
      // workCalendarName change observability — the most user-tangible
      // preference, and the one the user can't visually verify without
      // running a fresh sync. Log when present so we can confirm writes
      // are landing without spelunking Redis.
      if (Object.prototype.hasOwnProperty.call(preferences, "workCalendarName")) {
        const prev = typeof existing.workCalendarName === "string" ? existing.workCalendarName : "";
        const next = typeof preferences.workCalendarName === "string" ? preferences.workCalendarName : "";
        console.log(
          `[signals] workCalendarName write for ${userId}: ${JSON.stringify(prev)} -> ${JSON.stringify(next)}`
        );
      }
      await redis.set(`user:${userId}:preferences`, JSON.stringify(merged));
    }
    if (typeof expoPushToken === "string" && expoPushToken.length > 0) {
      await redis.set(`user:${userId}:expoPushToken`, expoPushToken);
    }
    if (healthData !== undefined) {
      // Stamp receipt so brief.js can decide whether the snapshot is stale.
      const stamped = { ...healthData, receivedAt: Date.now() };
      // Diagnostic logs — left in place so we can confirm health data is
      // flowing from a freshly-installed device without waiting for the
      // next brief to surface (or not surface) the values.
      console.log(
        `Health sync received for ${userId}: sleep=${healthData?.sleep?.duration}h HRV=${healthData?.hrv?.current} steps=${healthData?.steps}`
      );
      await redis.set(`user:${userId}:health`, JSON.stringify(stamped));
      console.log(`Health data stored at user:${userId}:health`);
    }
    return res.status(200).json({ ok: true, userId });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed for preferences" });
}

// Type-aware expiry windows. Different signal types decay at different
// rates — an appointment is dead the moment its time passes, but a
// package can drift two days past ETA before we should give up. Falls
// back to the original 24h EXPIRY_MS for types not explicitly listed.
const EXPIRY_BY_TYPE = {
  service: 0,             // appointments have no window — past = done
  reservation: 0,
  appointment: 0,
  food: 4 * 60 * 60 * 1000,        // 4h grace — delivery windows close fast
  grocery: 4 * 60 * 60 * 1000,
  package: 48 * 60 * 60 * 1000,    // 48h grace; flagged as missed cue
};

function applyDefaultsAndExpiry(signal) {
  const original = JSON.stringify(signal);
  const wasNotExpired = signal.state !== "expired";
  // Captured BEFORE the state defaulting below so a freshly-loaded
  // signal with no explicit state still reads as "user hasn't touched
  // it" for missed-cue flagging.
  const wasIncoming = !signal.state || signal.state === "incoming";
  if (!signal.state) signal.state = "incoming";

  let expiryReason = null;

  if (signal.state !== "resolved" && signal.state !== "expired" && signal.eta) {
    const etaMs = Date.parse(signal.eta);
    // V8 silently defaults year-less date strings ("Friday, May 15",
    // "May 15", "Dec 3") to year 2001 — Date.parse returns a number,
    // not NaN, so the naive past-check below would auto-expire any
    // signal a user typed without an explicit year. Guard against this
    // by treating any parsed date more than 5 years before now as
    // "probably year-less, no usable ETA" rather than expired.
    const SUSPICIOUSLY_OLD_MS = 5 * 365 * 24 * 60 * 60 * 1000;
    if (!isNaN(etaMs) && etaMs > Date.now() - SUSPICIOUSLY_OLD_MS) {
      const msPast = Date.now() - etaMs;
      const type = signal.type;
      const status = signal.status;
      // Per-type window; types not in the map fall back to the legacy
      // 24h rule so prior behavior is preserved for delivery/travel/
      // deadline/unknown signals.
      const window = EXPIRY_BY_TYPE[type] ?? EXPIRY_MS;

      let shouldExpire = false;
      if (type === "package") {
        // Packages also require status != "Delivered" — a delivered
        // package is fine to keep around in the resolved/active state
        // it was already in (most arrive with status:Delivered, so
        // they're a no-op here anyway).
        shouldExpire = msPast > window && status !== "Delivered";
      } else {
        shouldExpire = msPast > window;
      }

      if (shouldExpire) {
        signal.state = "expired";
        signal.expiredAt = new Date().toISOString();
        expiryReason = `eta-past-${type || "unknown"}-window`;
        // Missed cue = user never Rested or Held the signal before it
        // auto-expired. The Missed Cues screen reads from a separate
        // LPUSH'd list (handled by loadSignals after the per-signal
        // pass completes).
        if (wasIncoming) signal.missedCue = true;
      }
    }
  }

  // Stale no-ETA rule: signals stuck in "incoming" for >7 days with no
  // ETA at all were never actionable — they're radar clutter from
  // import sweeps that couldn't extract a date. Expire them so they
  // stop competing for brief attention. Falls back to signal.id when
  // lastUpdate is missing (id is Date.now() at import time).
  if (
    signal.state === "incoming" &&
    (!signal.eta || signal.eta === "" || signal.eta === "Unknown") &&
    wasIncoming
  ) {
    const lastMs = signal.lastUpdate ? Date.parse(signal.lastUpdate) : NaN;
    const ageMs = !isNaN(lastMs)
      ? Date.now() - lastMs
      : typeof signal.id === "number" && signal.id > 0
      ? Date.now() - signal.id
      : 0;
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    if (ageMs > SEVEN_DAYS_MS) {
      signal.state = "expired";
      signal.expiredAt = new Date().toISOString();
      signal.missedCue = true;
      expiryReason = "incoming-no-eta-stale-7d";
    }
  }

  const changed = JSON.stringify(signal) !== original;
  const justExpired = wasNotExpired && signal.state === "expired";
  if (justExpired) {
    console.log(
      `auto-expired signal ${signal.id} type=${signal.type || "unknown"} reason=${expiryReason || "unknown"}`
    );
  }
  return { signal, changed, justExpired };
}

// Camouflage rules — signals matching any rule never reach the brief,
// radar, or any consuming surface. Stored as a Redis SET of JSON
// strings under household:{id}:camouflage. Two rule kinds:
//   { type: "sender",     value: <normalized sender name>, addedAt }
//   { type: "signalType", value: <signal type enum>,       addedAt }
//
// Sender matches use normalizeSender for case-insensitive whitespace-
// collapsed equality so "FedEx", "fedex", and "FedEx " all dedupe to
// the same rule. signalType matches are exact.
function normalizeSender(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function loadCamouflageRules(householdId) {
  const raw = await redis.smembers(`household:${householdId}:camouflage`);
  if (!raw || raw.length === 0) return [];
  const rules = [];
  for (const r of raw) {
    try {
      const parsed = JSON.parse(r);
      if (parsed && (parsed.type === "sender" || parsed.type === "signalType")) {
        rules.push(parsed);
      }
    } catch { /* skip malformed */ }
  }
  return rules;
}

export function applyCamouflage(signals, rules) {
  if (!rules || rules.length === 0) return signals;
  const senderSet = new Set(
    rules.filter((r) => r.type === "sender").map((r) => r.value)
  );
  const typeSet = new Set(
    rules.filter((r) => r.type === "signalType").map((r) => r.value)
  );
  return signals.filter((s) => {
    if (!s) return false;
    if (typeSet.has(s.type)) return false;
    if (s.sender && senderSet.has(normalizeSender(s.sender))) return false;
    return true;
  });
}

async function handleCamouflage(req, res) {
  if (req.method === "GET") {
    const householdId = await resolveHouseholdId(req.query?.userId);
    const rules = await loadCamouflageRules(householdId);
    return res.status(200).json({ household: householdId, rules });
  }

  if (req.method === "POST") {
    const { userId, ruleType, value } = req.body || {};
    if (!userId) return res.status(400).json({ error: "userId required" });
    if (ruleType !== "sender" && ruleType !== "signalType") {
      return res.status(400).json({ error: "ruleType must be 'sender' or 'signalType'" });
    }
    if (!value || typeof value !== "string" || value.trim().length === 0) {
      return res.status(400).json({ error: "value required" });
    }

    const householdId = await resolveHouseholdId(userId);
    const normalizedValue = ruleType === "sender" ? normalizeSender(value) : value.trim();

    const rule = { type: ruleType, value: normalizedValue, addedAt: Date.now() };
    await redis.sadd(`household:${householdId}:camouflage`, JSON.stringify(rule));

    // Remove any currently-active signals matching the new rule so the
    // user sees the effect immediately. Goes through the full LRANGE +
    // LREM dance since SET membership doesn't help us find list entries.
    const signalKey = `household:${householdId}:signals`;
    const rawSignals = await redis.lrange(signalKey, 0, -1);
    let removedCount = 0;
    for (const raw of rawSignals) {
      let s;
      try { s = JSON.parse(raw); } catch { continue; }
      const matchesSender = ruleType === "sender"
        && s.sender && normalizeSender(s.sender) === normalizedValue;
      const matchesType = ruleType === "signalType" && s.type === normalizedValue;
      if (matchesSender || matchesType) {
        const removed = await redis.lrem(signalKey, 1, raw);
        if (removed > 0) removedCount++;
      }
    }

    console.log(
      `[camouflage] household=${householdId} added ${ruleType}="${normalizedValue}", removed ${removedCount} active signal(s)`
    );

    return res.status(200).json({ added: true, removedCount, rule });
  }

  if (req.method === "DELETE") {
    const userId = req.query?.userId || req.body?.userId;
    const value = req.query?.value || req.body?.value;
    if (!userId) return res.status(400).json({ error: "userId required" });
    if (!value || typeof value !== "string") {
      return res.status(400).json({ error: "value required" });
    }

    const householdId = await resolveHouseholdId(userId);
    const rules = await loadCamouflageRules(householdId);
    // Match by value alone — sender and signalType namespaces don't
    // collide in practice (sender names contain spaces; type enum
    // doesn't) and the mobile screen identifies rules by value.
    const matching = rules.filter((r) => r.value === value);
    for (const r of matching) {
      await redis.srem(`household:${householdId}:camouflage`, JSON.stringify(r));
    }

    console.log(
      `[camouflage] household=${householdId} removed ${matching.length} rule(s) matching "${value}"`
    );

    return res.status(200).json({ removed: matching.length });
  }

  res.setHeader("Allow", "GET, POST, DELETE");
  return res.status(405).json({ error: "Method not allowed for camouflage" });
}

async function loadSignals(householdId) {
  const key = `household:${householdId}:signals`;
  const raw = await redis.lrange(key, 0, -1);
  const signals = raw.map(parseSignal);
  // Signals that auto-expired AND were never touched by the user. We
  // stash these in a separate list so the Missed Cues screen can show
  // "what slipped past you" without re-scanning the full signals list
  // for state:expired + state-was-incoming pairings.
  const missedCues = [];

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
      if (signal.missedCue) {
        missedCues.push(signal);
      }
    }
  }

  // Persist newly-flagged missed cues, capped at 100 entries via LTRIM
  // so the list never grows unboundedly. Newest at the head (LPUSH).
  if (missedCues.length > 0) {
    const mcKey = `household:${householdId}:missedCues`;
    for (const mc of missedCues) {
      await redis.lpush(mcKey, JSON.stringify(mc));
    }
    await redis.ltrim(mcKey, 0, 99);
  }

  // Follow-up detection: signals where state is incoming/active AND the
  // ETA passed between 1-3 hours ago AND followUpSent is not already set.
  // These are signals the user might have forgotten to Rest or Hold — the
  // /api/followup cron picks them up and sends a "Quick check" push asking
  // whether it happened. We mark followUpSent=true here so the same signal
  // doesn't re-queue across multiple GETs in the same window.
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
  const SUSPICIOUSLY_OLD_MS = 5 * 365 * 24 * 60 * 60 * 1000;
  const followUpAdds = [];
  for (let i = 0; i < signals.length; i++) {
    const s = signals[i];
    if (s.state !== "incoming" && s.state !== "active") continue;
    if (s.followUpSent === true) continue;
    if (!s.eta) continue;
    const etaMs = Date.parse(s.eta);
    if (isNaN(etaMs)) continue;
    // Year-less date guard (same as the expiry path): skip absurdly old
    // parsed dates which V8 produces for "May 15" → 2001.
    if (etaMs < Date.now() - SUSPICIOUSLY_OLD_MS) continue;
    const msPast = Date.now() - etaMs;
    if (msPast < ONE_HOUR_MS || msPast > THREE_HOURS_MS) continue;
    s.followUpSent = true;
    followUpAdds.push(String(s.id));
    await redis.lset(key, i, JSON.stringify(s));
  }
  if (followUpAdds.length > 0) {
    await redis.sadd(`household:${householdId}:pendingFollowups`, ...followUpAdds);
    // 24h TTL — well past the 3h follow-up window so we never lose a
    // pending entry, but cleaned up if the followup cron stops running.
    await redis.expire(`household:${householdId}:pendingFollowups`, 24 * 60 * 60);
    console.log(
      `[signals] queued ${followUpAdds.length} follow-up(s) for ${householdId}: ${followUpAdds.join(", ")}`
    );
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

    // Crew — household:{id}:crew JSON-string array of children + pets.
    if (queryType === "crew" || bodyType === "crew") {
      return handleCrew(req, res);
    }

    // Calendar — merged household calendar events. GET only. Feeds the
    // Programme screen's 14-day timeline so the mobile app doesn't have
    // to know about the per-user calendar fan-out + legacy single-key
    // fallback handled in api/calendar-loader.js.
    if (queryType === "calendar") {
      return handleCalendarRead(req, res);
    }

    // Compass — longitudinal household intelligence over the memory log.
    // Powers the Compass screen.
    if (queryType === "compass" || bodyType === "compass") {
      return handleCompass(req, res);
    }

    // Health snapshot — returns whatever the most recent healthData POST
    // wrote to user:{userId}:health. Used to verify Apple Watch data is
    // actually flowing without waiting for the next brief generation.
    if (queryType === "health") {
      return handleHealthRead(req, res);
    }

    // Transactions — read-only view of household:{id}:transactions
    // (written by api/import.js's financial branch). Most-recent first;
    // limit defaults to 50, max 500 (matches the LTRIM cap).
    if (queryType === "transactions") {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        return res.status(405).json({ error: "Method not allowed for transactions" });
      }
      const householdId = await resolveHouseholdId(req.query?.userId);
      const requestedLimit = parseInt(req.query?.limit, 10);
      const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, 500) : 50;
      const raw = await redis.lrange(`household:${householdId}:transactions`, 0, limit - 1);
      const transactions = [];
      for (const r of raw) {
        try { transactions.push(JSON.parse(r)); } catch { /* skip malformed */ }
      }
      // Sort by date descending; storedAt fallback when date missing.
      transactions.sort((a, b) => {
        const da = a.date ? Date.parse(a.date) : (a.storedAt || 0);
        const db = b.date ? Date.parse(b.date) : (b.storedAt || 0);
        return (db || 0) - (da || 0);
      });
      return res.status(200).json({ household: householdId, transactions });
    }

    // Providers — service-provider directory at
    // household:{id}:providers (Redis hash keyed by normalized name).
    // GET lists all providers; POST manually adds one. Auto-population
    // happens in api/import.js for service-classified emails.
    if (queryType === "providers" || bodyType === "providers") {
      const householdId = await resolveHouseholdId(req.query?.userId || req.body?.userId);
      const hashKey = `household:${householdId}:providers`;

      if (req.method === "GET") {
        const raw = await redis.hgetall(hashKey);
        const providers = [];
        if (raw && typeof raw === "object") {
          for (const [key, value] of Object.entries(raw)) {
            const parsed = safeJson(value);
            if (parsed) providers.push({ ...parsed, _key: key });
          }
        }
        return res.status(200).json({ household: householdId, providers });
      }

      if (req.method === "POST") {
        const { userId, name, serviceType, phone, email, website, notes, estimateAmount } = req.body || {};
        if (!userId) return res.status(400).json({ error: "userId required" });
        if (!name || typeof name !== "string" || name.trim().length === 0) {
          return res.status(400).json({ error: "name required" });
        }
        // Same normalization the import path uses — lowercase, strip
        // entity suffixes, collapse whitespace, drop punctuation.
        const normKey = name
          .toLowerCase()
          .replace(/[.,]/g, " ")
          .replace(/\b(llc|inc|incorporated|co|corp|corporation|ltd|pllc|pa|pc|plc)\b/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        if (!normKey) return res.status(400).json({ error: "invalid name" });

        const now = new Date().toISOString();
        const existingRaw = await redis.hget(hashKey, normKey);
        const existing = safeJson(existingRaw);
        const merged = {
          ...(existing || {}),
          name: name.trim(),
          serviceType: serviceType || existing?.serviceType || "other",
          phone: phone || existing?.phone || null,
          email: email || existing?.email || null,
          website: website || existing?.website || null,
          notes: notes !== undefined ? (notes || null) : (existing?.notes || null),
          estimateAmount: estimateAmount ?? existing?.estimateAmount ?? null,
          firstSeen: existing?.firstSeen || now,
          lastSeen: now,
          source: existing?.source || "manual",
        };
        await redis.hset(hashKey, { [normKey]: JSON.stringify(merged) });
        return res.status(200).json({ household: householdId, provider: { ...merged, _key: normKey } });
      }

      if (req.method === "DELETE") {
        const key = req.query?.key || req.body?.key;
        if (!key) return res.status(400).json({ error: "key required" });
        await redis.hdel(hashKey, String(key));
        return res.status(200).json({ removed: true });
      }

      res.setHeader("Allow", "GET, POST, DELETE");
      return res.status(405).json({ error: "Method not allowed for providers" });
    }

    // Inventory — single JSON object at household:{id}:inventory.
    // GET returns the stored object (or an empty default shape on
    // first read); POST shallow-merges updates. Mobile inline-edit
    // commits flow through here.
    if (queryType === "inventory" || bodyType === "inventory") {
      const householdId = await resolveHouseholdId(req.query?.userId || req.body?.userId);
      const inventoryKey = `household:${householdId}:inventory`;
      const DEFAULT_INVENTORY = {
        roof: { material: null, yearInstalled: null, lastInspected: null },
        hvac: { brand: null, yearInstalled: null, lastServiced: null, filterSize: null },
        waterHeater: { yearInstalled: null, type: null },
        electrical: { panelAmps: null, yearUpdated: null },
        vehicles: [],
        appliances: [],
        homeBuiltYear: null,
        squareFootage: null,
        notes: null,
      };

      if (req.method === "GET") {
        const raw = await redis.get(inventoryKey);
        const inventory = safeJson(raw) || DEFAULT_INVENTORY;
        // Merge defaults so newly-added fields appear in old documents.
        const merged = { ...DEFAULT_INVENTORY, ...inventory };
        return res.status(200).json({ household: householdId, inventory: merged });
      }

      if (req.method === "POST") {
        const { userId, updates } = req.body || {};
        if (!userId) return res.status(400).json({ error: "userId required" });
        if (!updates || typeof updates !== "object") {
          return res.status(400).json({ error: "updates object required" });
        }
        const raw = await redis.get(inventoryKey);
        const existing = safeJson(raw) || DEFAULT_INVENTORY;
        // Shallow-merge top-level keys. Sub-objects (roof, hvac,
        // waterHeater, electrical) get nested merges so a partial
        // patch doesn't nuke unrelated sub-fields.
        const merged = { ...existing };
        for (const [k, v] of Object.entries(updates)) {
          if (v === null || typeof v !== "object" || Array.isArray(v)) {
            merged[k] = v;
          } else {
            merged[k] = { ...(existing[k] || {}), ...v };
          }
        }
        await redis.set(inventoryKey, JSON.stringify(merged));
        return res.status(200).json({ household: householdId, inventory: merged });
      }

      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed for inventory" });
    }

    // Location — per-household city/state/lat/lon/marketRegion. GET
    // returns the stored location, auto-detecting from the caller's
    // IP on first read. POST manually sets the location (Settings →
    // Household → Location edit).
    if (queryType === "location" || bodyType === "location") {
      if (req.method === "GET") {
        const householdId = await resolveHouseholdId(req.query?.userId);
        const location = await detectOrLoadLocation(householdId, req);
        return res.status(200).json({ household: householdId, location });
      }
      if (req.method === "POST") {
        const { userId, city, state, lat, lon, timezone } = req.body || {};
        if (!userId) return res.status(400).json({ error: "userId required" });
        if (!city || !state) return res.status(400).json({ error: "city and state required" });
        const householdId = await resolveHouseholdId(userId);
        try {
          const location = await saveHouseholdLocation(householdId, { city, state, lat, lon, timezone });
          return res.status(200).json({ household: householdId, location });
        } catch (err) {
          return res.status(400).json({ error: err?.message || "save failed" });
        }
      }
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed for location" });
    }

    // Camouflage — per-household filter rules. GET lists rules, POST
    // adds + scrubs matching active signals, DELETE removes a rule.
    if (queryType === "camouflage" || bodyType === "camouflage") {
      return handleCamouflage(req, res);
    }

    if (req.method === "GET") {
      const householdId = await resolveHouseholdId(req.query.userId);
      const [{ signals }, camouflageRules] = await Promise.all([
        loadSignals(householdId),
        loadCamouflageRules(householdId),
      ]);
      // Camouflaged signals never leave this handler — every consumer
      // (brief, radar, hover, programme) reads the filtered list. The
      // rules are also checked at POST-rule time to scrub current
      // active signals, so this is the second line of defense.
      const filtered = applyCamouflage(signals, camouflageRules);
      return res.status(200).json({ household: householdId, signals: filtered });
    }

    // Manual signal creation. Mobile's "+ Add Signal" sheet posts here
    // with { userId, description, type, eta, sender, source }. State is
    // server-set to "incoming" so the new dot lands on the radar via
    // the same lifecycle as imported signals. Source defaults to
    // "manual" but caller may override (e.g., a future quick-action
    // surface might tag its own source).
    if (req.method === "POST") {
      const body = req.body || {};
      const { userId, description, type, eta, sender, source, status } = body;

      if (!userId) {
        return res.status(400).json({ error: "userId is required" });
      }
      if (typeof description !== "string" || description.trim().length === 0) {
        return res.status(400).json({ error: "description is required" });
      }

      const householdId = await resolveHouseholdId(userId);

      const signal = {
        id: Date.now(),
        description: description.trim(),
        type: typeof type === "string" && type.length > 0 ? type : "unknown",
        eta: typeof eta === "string" && eta.trim().length > 0 ? eta.trim() : null,
        sender: typeof sender === "string" && sender.trim().length > 0 ? sender.trim() : null,
        status: typeof status === "string" && status.length > 0 ? status : null,
        state: "incoming",
        source: typeof source === "string" && source.length > 0 ? source : "manual",
        userId,
        lastUpdate: new Date().toLocaleString(),
        createdAt: Date.now(),
      };

      await redis.lpush(`household:${householdId}:signals`, JSON.stringify(signal));

      return res.status(201).json({ household: householdId, signal });
    }

    if (req.method === "PATCH") {
      const body = req.body || {};
      const { id, state, userId, notedAt, description, eta, status, notes, confirmationNumber } = body;

      if (id === undefined || id === null) {
        return res.status(400).json({ error: "id is required" });
      }

      // PATCH accepts EITHER a state transition (existing lifecycle
      // semantics) OR a field edit (description / eta / status / notes /
      // confirmationNumber), or both in one call. FinaleSheet edit mode
      // sends just the edit fields; resolve/hold flows send just state.
      // Horizon's inline-edit affordances send notes/confirmationNumber.
      const stateProvided = state !== undefined;
      const hasDescription = typeof description === "string";
      const hasEta = "eta" in body; // allow null to clear
      const hasStatus = typeof status === "string";
      const hasNotes = "notes" in body; // allow null/empty to clear
      const hasConfirmation = "confirmationNumber" in body;
      const isEdit = hasDescription || hasEta || hasStatus || hasNotes || hasConfirmation;

      if (!stateProvided && !isEdit) {
        return res.status(400).json({
          error: "at least one of state, description, eta, status, notes, or confirmationNumber is required",
        });
      }
      if (stateProvided && !VALID_STATES.includes(state)) {
        return res.status(400).json({
          error: `state must be one of ${VALID_STATES.join(", ")}`,
        });
      }

      // Apply edit fields onto a target signal record. lastUpdate is
      // bumped here so any change — edit, state, or both — produces a
      // fresh timestamp.
      function applyEditFields(record) {
        if (hasDescription) record.description = description;
        if (hasEta) record.eta = eta;
        if (hasStatus) record.status = status;
        if (hasNotes) record.notes = notes === "" ? null : notes;
        if (hasConfirmation) record.confirmationNumber = confirmationNumber === "" ? null : confirmationNumber;
      }

      const householdId = await resolveHouseholdId(userId);
      const { key, signals } = await loadSignals(householdId);

      let index = signals.findIndex(s => s.id === id || String(s.id) === String(id));

      if (index !== -1) {
        // Primary path — id is in :signals.
        const previousLastUpdate = signals[index].lastUpdate;
        applyEditFields(signals[index]);
        if (stateProvided) {
          signals[index].state = state;
        }
        signals[index].lastUpdate = new Date().toLocaleString();
        if (typeof notedAt === "string" && notedAt.length > 0) {
          signals[index].notedAt = notedAt;
        }
        await redis.lset(key, index, JSON.stringify(signals[index]));

        // Memory log fires only on state lifecycle transitions, not on
        // pure field edits. An edit isn't a "resolved" or "held" event;
        // logging it would pollute the longitudinal feed and Compass.
        if (stateProvided && (state === "resolved" || state === "active")) {
          const action = state === "resolved" ? "resolved" : "held";
          const memorySignal = { ...signals[index], lastUpdate: previousLastUpdate };
          await writeMemoryEntry(householdId, memorySignal, action, userId);
          // Caught moment — only on resolved transitions; close-call to
          // the signal's ETA.
          if (state === "resolved") {
            const criterion = detectCaughtMoment(signals[index], { kind: "signal" });
            if (criterion) await recordCaughtMoment(householdId, signals[index], criterion, userId);
          }
        }
        return res.status(200).json({ household: householdId, signal: signals[index] });
      }

      // Fallback path — id might belong to the :deadlines list, which is a
      // separate store but is exposed alongside signals on the Horizon
      // screen. Same edit + state + memory-log semantics apply.
      const deadlinesKey = `household:${householdId}:deadlines`;
      const rawDeadlines = await redis.lrange(deadlinesKey, 0, -1);
      const deadlines = rawDeadlines.map(parseSignal);
      index = deadlines.findIndex(d => d.id === id || String(d.id) === String(id));
      if (index === -1) {
        return res.status(404).json({ error: "signal not found" });
      }

      const previousLastUpdate = deadlines[index].lastUpdate;
      applyEditFields(deadlines[index]);
      if (stateProvided) {
        deadlines[index].state = state;
      }
      deadlines[index].lastUpdate = new Date().toLocaleString();
      if (typeof notedAt === "string" && notedAt.length > 0) {
        deadlines[index].notedAt = notedAt;
      }
      await redis.lset(deadlinesKey, index, JSON.stringify(deadlines[index]));

      if (stateProvided && (state === "resolved" || state === "active")) {
        const action = state === "resolved" ? "resolved" : "held";
        // Tag type as "deadline" for the memory entry so the patterns
        // endpoint can see it in the typeBreakdown bucket.
        const memorySignal = {
          ...deadlines[index],
          lastUpdate: previousLastUpdate,
          type: deadlines[index].type || "deadline",
        };
        await writeMemoryEntry(householdId, memorySignal, action, userId);
        // Caught moment — deadline items on resolved transition.
        if (state === "resolved") {
          const item = { ...deadlines[index], type: deadlines[index].type || "deadline" };
          const criterion = detectCaughtMoment(item, { kind: "deadline" });
          if (criterion) await recordCaughtMoment(householdId, item, criterion, userId);
        }
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
