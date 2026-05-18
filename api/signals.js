import crypto from "node:crypto";
import { Redis } from "@upstash/redis";
import { loadHouseholdCalendar } from "./calendar-loader.js";
import { detectOrLoadLocation, saveHouseholdLocation, loadHouseholdLocation } from "./location.js";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Signed photo URLs — HMAC the (householdId, pathname, expiresAt)
// tuple with a server-side secret. BLOB_READ_WRITE_TOKEN is a stable
// per-store secret on Vercel; using it here means signatures are
// only valid against the same Blob store that holds the photos.
// Falls back to ANTHROPIC_API_KEY (also stable + Vercel-injected)
// so dev environments without Blob can still smoke-test the path.
const PHOTO_SIGNING_SECRET = () =>
  process.env.BLOB_READ_WRITE_TOKEN ||
  process.env.ANTHROPIC_API_KEY ||
  "conductor-photo-secret";

const PHOTO_TTL_MS = 60 * 60 * 1000;
const PUBLIC_BASE = "https://conductor-ivory.vercel.app";

function signPhotoToken(householdId, pathname, expiresAt) {
  return crypto
    .createHmac("sha256", PHOTO_SIGNING_SECRET())
    .update(`${householdId}|${pathname}|${expiresAt}`)
    .digest("hex")
    .slice(0, 32);
}

function signedPhotoUrl(householdId, pathname) {
  const expiresAt = Date.now() + PHOTO_TTL_MS;
  const sig = signPhotoToken(householdId, pathname, expiresAt);
  const params = new URLSearchParams({
    type: "crew-photo-fetch",
    hid: householdId,
    p: pathname,
    e: String(expiresAt),
    s: sig,
  });
  return `${PUBLIC_BASE}/api/signals?${params.toString()}`;
}

const VALID_STATES = ["incoming", "active", "resolved", "expired", "snoozed"];
const DEFAULT_SNOOZE_MS = 24 * 60 * 60 * 1000;
const EXPIRY_MS = 24 * 60 * 60 * 1000;

// Drop the per-user brief cache for every member of a household.
// Called from the PATCH signal/deadline paths when description /
// eta / status change — the cached prose would otherwise misquote
// the edited field until its TTL expires.
async function invalidateBriefCache(householdId) {
  if (!householdId) return;
  // Find every user whose household resolves to this id. Mirrors
  // the scan pattern in sync.js / notify.js.
  const keys = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, { match: "user:*:household", count: 100 });
    cursor = next;
    if (batch?.length) keys.push(...batch);
  } while (cursor !== "0" && cursor !== 0);
  const members = [];
  for (const key of keys) {
    const userId = key.slice("user:".length, -":household".length);
    const hid = await redis.get(key);
    if ((hid || userId) === householdId) members.push(userId);
  }
  const del = [];
  for (const uid of members) {
    del.push(redis.del(`user:${uid}:currentTakeoff`));
    del.push(redis.del(`user:${uid}:currentClearance`));
    del.push(redis.del(`user:${uid}:currentMidday`));
  }
  await Promise.all(del);
  console.log(
    `[cache] invalidated brief cache for household ${householdId} (${members.length} members)`
  );
}

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

// Streak update. Fires on every state→resolved transition.
// Counter math:
//   - same day as last resolution    → totalResolved++ only
//   - exactly yesterday              → totalResolved++, currentStreak++,
//                                      longestStreak = max(...)
//   - more than one day after last   → reset currentStreak to 1,
//                                      stamp a fresh streakStartDate
// Day boundaries use America/New_York to match the user-facing
// clearance "this week" definition. Returns the post-update record.
function todayETKey(date = new Date()) {
  return date.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "numeric",
  });
}

function yesterdayETKey() {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return todayETKey(d);
}

export async function updateStreak(householdId) {
  const key = `household:${householdId}:streakData`;
  let raw = await redis.get(key);
  let data = null;
  try { data = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { data = null; }
  if (!data || typeof data !== "object") {
    data = {
      currentStreak: 0,
      longestStreak: 0,
      lastResolutionDate: null,
      totalResolved: 0,
      streakStartDate: null,
    };
  }
  const today = todayETKey();
  const yest = yesterdayETKey();
  data.totalResolved = (data.totalResolved || 0) + 1;
  if (data.lastResolutionDate === today) {
    // Already counted today — totalResolved bumped, streak untouched.
  } else if (data.lastResolutionDate === yest) {
    data.currentStreak = (data.currentStreak || 0) + 1;
    data.lastResolutionDate = today;
  } else {
    // Either no prior or gap of 2+ days — fresh streak.
    data.currentStreak = 1;
    data.lastResolutionDate = today;
    data.streakStartDate = today;
  }
  if ((data.currentStreak || 0) > (data.longestStreak || 0)) {
    data.longestStreak = data.currentStreak;
  }
  await redis.set(key, JSON.stringify(data));
  return data;
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
    const [raw, rawSignals] = await Promise.all([
      redis.get(`household:${householdId}:crew`),
      redis.lrange(`household:${householdId}:signals`, 0, -1).catch(() => []),
    ]);
    let crew = [];
    if (raw != null) {
      try {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (Array.isArray(parsed)) crew = parsed;
      } catch {
        // malformed payload — return empty rather than 500
      }
    }
    // Bucket signals by crewMemberId so the per-member attribution
    // lookup is O(n) total instead of O(n * m).
    const signalsByMember = new Map();
    for (const r of rawSignals || []) {
      const s = (() => { try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; } })();
      if (!s || !s.crewMemberId) continue;
      // Skip resolved/expired — only surface live attributions.
      if (s.state && s.state !== "incoming" && s.state !== "active") continue;
      const key = String(s.crewMemberId).toLowerCase().trim();
      if (!signalsByMember.has(key)) signalsByMember.set(key, []);
      signalsByMember.get(key).push(s);
    }
    // Generate fresh signed photoUrls — 1-hour expiry, regenerated
    // every GET so the mobile app gets a usable URL whenever it
    // refreshes (focus, pull-to-refresh, etc.). Legacy public
    // photoUrl values (from before the private-blob switch) are
    // passed through untouched so older uploads still render.
    // Also stamp attributedSignals (up to 5 most recent) + count
    // so the expanded card can render the SIGNALS row without a
    // second roundtrip.
    crew = crew.map((m) => {
      if (!m || typeof m !== "object") return m;
      const next = { ...m };
      if (m.photoBlobPathname) {
        next.photoUrl = signedPhotoUrl(householdId, m.photoBlobPathname);
      }
      if (m.name) {
        const k = m.name.toLowerCase().trim();
        const bucket = signalsByMember.get(k) || [];
        // Newest first by signal id (id = Date.now() at import).
        bucket.sort((a, b) => (b.id || 0) - (a.id || 0));
        next.attributedSignals = bucket.slice(0, 5).map((s) => ({
          id: s.id,
          description: s.description,
          type: s.type,
          eta: s.eta,
          state: s.state,
          status: s.status,
        }));
        next.attributedSignalCount = bucket.length;
      }
      return next;
    });
    return res.status(200).json({ household: householdId, crew });
  }

  if (req.method === "POST") {
    // CRUD via action param: add/edit/remove. Existing
    // birthday-only POST shape (no action) flows through to the
    // legacy path below unchanged.
    const action = req.body?.action;
    if (action === "add" || action === "edit" || action === "remove") {
      const { userId, member, memberName } = req.body || {};
      if (!userId) return res.status(400).json({ error: "userId required" });
      const householdId = await resolveHouseholdId(userId);
      const crewKey = `household:${householdId}:crew`;
      const rawCrew = await redis.get(crewKey);
      const crew = Array.isArray(safeJson(rawCrew)) ? safeJson(rawCrew) : [];

      if (action === "add") {
        if (!member || typeof member !== "object" || !member.name || !member.memberType) {
          return res.status(400).json({ error: "member.name and member.memberType required" });
        }
        // Dedup on memberType + lowercase name to avoid double-adds
        // when the user taps Save twice or re-runs a re-onboard.
        const exists = crew.find(
          (m) =>
            m && m.memberType === member.memberType &&
            (m.name || "").toLowerCase().trim() === String(member.name).toLowerCase().trim()
        );
        if (exists) {
          return res.status(409).json({ error: "Crew member already exists", member: exists });
        }
        crew.push({ ...member, addedAt: new Date().toISOString() });
        await redis.set(crewKey, JSON.stringify(crew));
        return res.status(200).json({ ok: true, household: householdId, member: crew[crew.length - 1] });
      }

      if (action === "edit") {
        if (!memberName) return res.status(400).json({ error: "memberName required" });
        const idx = crew.findIndex(
          (m) =>
            m && (m.name || "").toLowerCase().trim() === String(memberName).toLowerCase().trim()
        );
        if (idx === -1) return res.status(404).json({ error: "member not found" });
        // Whitelist what edit can touch — never overwrites
        // memberType, photo blob refs, or sender patterns.
        const ALLOWED = [
          "name", "age", "birthday", "anniversary",
          "school", "grade", "activities",
          "type", "breed", "vet",
          "relationship",
          "notes", "prescriptions", "doctors",
        ];
        const updates = member && typeof member === "object" ? member : {};
        for (const k of ALLOWED) {
          if (Object.prototype.hasOwnProperty.call(updates, k)) {
            crew[idx][k] = updates[k];
          }
        }
        await redis.set(crewKey, JSON.stringify(crew));
        return res.status(200).json({ ok: true, household: householdId, member: crew[idx] });
      }

      // remove
      if (!memberName) return res.status(400).json({ error: "memberName required" });
      const before = crew.length;
      const next = crew.filter(
        (m) => !(m && (m.name || "").toLowerCase().trim() === String(memberName).toLowerCase().trim())
      );
      if (next.length === before) {
        return res.status(404).json({ error: "member not found" });
      }
      await redis.set(crewKey, JSON.stringify(next));
      return res.status(200).json({ ok: true, household: householdId, removed: memberName });
    }

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

  // PATCH — generic field updates for a named crew member. Used by
  // the mobile bio editor (notes, prescriptions, doctors, signalTypes,
  // photoUrl, etc.). Distinct from the POST path which only edits
  // birthday/anniversary. memberName is matched case-insensitive,
  // memberType is optional (helps disambiguate when names collide
  // across child/pet).
  if (req.method === "PATCH") {
    const { userId, memberName, memberType, updates } = req.body || {};
    if (!userId) return res.status(400).json({ error: "userId required" });
    if (!memberName) return res.status(400).json({ error: "memberName required" });
    if (!updates || typeof updates !== "object") {
      return res.status(400).json({ error: "updates object required" });
    }
    const householdId = await resolveHouseholdId(userId);
    const crewKey = `household:${householdId}:crew`;
    const rawCrew = await redis.get(crewKey);
    const crew = Array.isArray(safeJson(rawCrew)) ? safeJson(rawCrew) : [];
    let idx = -1;
    for (let i = 0; i < crew.length; i++) {
      const m = crew[i];
      if (!m || !m.name) continue;
      const nameMatch = m.name.toLowerCase().trim() === memberName.toLowerCase().trim();
      const typeMatch = !memberType || m.memberType === memberType;
      if (nameMatch && typeMatch) { idx = i; break; }
    }
    if (idx === -1) return res.status(404).json({ error: "Crew member not found" });
    // Whitelisted updateable fields — avoid letting the client clobber
    // memberType/name/birthday by accident.
    const ALLOWED = [
      "photoUrl", "notes", "prescriptions", "doctors",
      "signalTypes", "senderPatterns", "lastGrooming",
      "school", "activities", "upcomingEvents",
    ];
    for (const k of ALLOWED) {
      if (Object.prototype.hasOwnProperty.call(updates, k)) {
        crew[idx][k] = updates[k];
      }
    }
    await redis.set(crewKey, JSON.stringify(crew));
    return res.status(200).json({ ok: true, household: householdId, member: crew[idx] });
  }

  res.setHeader("Allow", "GET, POST, PATCH");
  return res.status(405).json({ error: "Method not allowed for crew" });
}

async function handleVault(req, res) {
  const householdId = await resolveHouseholdId(req.query?.userId || req.body?.userId);
  const key = `household:${householdId}:vault`;

  if (req.method === "GET") {
    const [raw, rawShared] = await Promise.all([
      redis.lrange(key, 0, -1),
      // Shared vault items pushed in from connected households via
      // /api/network?action=share-vault. Flagged with isShared on
      // the way out so the mobile UI can render the read-only
      // "Shared with you" section.
      redis.lrange(`household:${householdId}:sharedVault`, 0, -1).catch(() => []),
    ]);
    let items = raw
      .map(parseSignal)
      .filter(Boolean)
      .filter((v) => !v.handled);
    const sharedItems = (rawShared || [])
      .map(parseSignal)
      .filter(Boolean)
      .map((s) => ({ ...s, isShared: true }));
    items = [...items, ...sharedItems];

    // Lease items get computed fields at read time so the mobile
    // doesn't have to re-derive notice deadlines + mileage overage.
    // Residential leases: noticeDeadline = leaseEnd - noticeRequired
    // days. Vehicle leases: projectedOverage = (estimatedMileageAtEnd)
    // - allowance, using inventory vehicle mileage when matchable.
    let inventoryVehicles = [];
    try {
      const rawInv = await redis.get(`household:${householdId}:inventory`);
      const inv = rawInv ? (typeof rawInv === "string" ? JSON.parse(rawInv) : rawInv) : null;
      if (inv && Array.isArray(inv.vehicles)) inventoryVehicles = inv.vehicles;
    } catch { /* skip */ }
    items = items.map((v) => {
      if (v.category === "lease_residential") {
        try {
          if (v.leaseEnd && v.noticeRequired) {
            const end = new Date(v.leaseEnd);
            if (!isNaN(end.getTime())) {
              const notice = new Date(end);
              notice.setDate(notice.getDate() - Number(v.noticeRequired));
              v.noticeDeadline = notice.toISOString().slice(0, 10);
              v.daysUntilNoticeDeadline = Math.round(
                (notice.getTime() - Date.now()) / (24 * 60 * 60 * 1000)
              );
              // Surface noticeDeadline as the renewalDate so existing
              // vault sort/urgency logic picks it up.
              if (!v.renewalDate) v.renewalDate = v.noticeDeadline;
            }
          }
        } catch { /* skip */ }
      } else if (v.category === "lease_vehicle") {
        try {
          if (v.leaseEnd && v.annualMileageAllowance) {
            const end = new Date(v.leaseEnd);
            if (!isNaN(end.getTime())) {
              // Match inventory vehicle by make/model/year.
              const match = inventoryVehicles.find(
                (iv) =>
                  iv &&
                  String(iv.make || "").toLowerCase() === String(v.vehicleMake || "").toLowerCase() &&
                  String(iv.model || "").toLowerCase() === String(v.vehicleModel || "").toLowerCase() &&
                  Number(iv.year) === Number(v.vehicleYear)
              );
              const currentMileage =
                Number(match?.currentMileage) ||
                Number(v.currentMileageEstimate) ||
                0;
              // Estimate years remaining in the lease.
              const yearsTotal =
                v.leaseStart && !isNaN(Date.parse(v.leaseStart))
                  ? (end.getTime() - Date.parse(v.leaseStart)) /
                    (365.25 * 24 * 60 * 60 * 1000)
                  : 3;
              const yearsRemaining =
                (end.getTime() - Date.now()) /
                (365.25 * 24 * 60 * 60 * 1000);
              const yearsElapsed = Math.max(0, yearsTotal - yearsRemaining);
              const milesPerYear =
                yearsElapsed > 0 ? currentMileage / yearsElapsed : 0;
              const projectedAtEnd =
                yearsElapsed > 0
                  ? Math.round(milesPerYear * yearsTotal)
                  : currentMileage;
              const overage =
                projectedAtEnd - Number(v.annualMileageAllowance) * yearsTotal;
              v.projectedMileageAtEnd = projectedAtEnd;
              v.projectedOverage = Math.round(overage);
              v.projectedOverageCost =
                overage > 0 && v.overageCostPerMile
                  ? Math.round(overage * Number(v.overageCostPerMile))
                  : null;
              if (!v.renewalDate) v.renewalDate = v.leaseEnd;
            }
          }
        } catch { /* skip */ }
      }
      return v;
    });

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

  // Snooze auto-rehydrate: when snoozedUntil has passed, flip state
  // back to active so the signal re-enters brief pools naturally.
  // Snooze is a temporary mute, not a lifecycle terminus.
  if (signal.state === "snoozed" && signal.snoozedUntil) {
    const untilMs = Date.parse(signal.snoozedUntil);
    if (!isNaN(untilMs) && untilMs < Date.now()) {
      signal.state = "active";
      delete signal.snoozedUntil;
    }
  }

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

// ---------- Conductor Junior ----------

const BADGE_DEFINITIONS = [
  { id: "first_signal", name: "First signal", description: "Added your first school signal." },
  { id: "week_streak", name: "Week streak", description: "7 consecutive days of chore completion." },
  { id: "saver", name: "Saver", description: "Reached a savings goal." },
  { id: "organized", name: "Organized", description: "Added 5 school signals in one month." },
  { id: "reliable", name: "Reliable", description: "Completed all chores 2 weeks straight." },
];

// Resolve the crew member record + parent household for a child user
// id. Children are stored as crew rows with juniorAccess=true and a
// juniorUserId. We don't have a separate user:{id} mapping for them
// — the parent's household key is authoritative.
async function resolveJuniorContext(juniorUserId) {
  if (!juniorUserId) return null;
  // Direct lookup first — a child can have their own user:{id}:household
  // mapping if a parent set one up; otherwise scan the parent's crew.
  let householdId = await redis.get(`user:${juniorUserId}:household`);
  let childRecord = null;

  if (householdId) {
    const rawCrew = await redis.get(`household:${householdId}:crew`);
    const crew = safeJson(rawCrew) || [];
    if (Array.isArray(crew)) {
      childRecord = crew.find(
        (m) => m && (m.juniorUserId === juniorUserId || m.userId === juniorUserId)
      ) || null;
    }
  }
  return { householdId, childRecord };
}

function calculateChoreStreak(chores) {
  // Streak = consecutive days where AT LEAST one chore was completed,
  // counting back from today.
  const allDates = new Set();
  for (const c of chores || []) {
    for (const d of c?.completedDates || []) {
      if (typeof d === "string") allDates.add(d.slice(0, 10));
    }
  }
  let streak = 0;
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  for (let i = 0; i < 365; i++) {
    const key = day.toISOString().slice(0, 10);
    if (allDates.has(key)) {
      streak += 1;
      day.setDate(day.getDate() - 1);
    } else if (i === 0) {
      // Allow no-chore today without breaking streak — start counting
      // from yesterday if today is empty.
      day.setDate(day.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

function evaluateBadges(child, streak, juniorSignalsThisMonth) {
  const earned = new Set((child.badges || []).map((b) => b.id));
  const newBadges = [];
  const award = (id) => {
    if (earned.has(id)) return;
    const def = BADGE_DEFINITIONS.find((d) => d.id === id);
    if (!def) return;
    newBadges.push({
      id: def.id,
      name: def.name,
      description: def.description,
      earnedAt: new Date().toISOString(),
    });
    earned.add(id);
  };
  if ((child.signalsCreated || 0) >= 1) award("first_signal");
  if (streak >= 7) award("week_streak");
  if (
    child.savingsGoal &&
    typeof child.savingsGoal.currentAmount === "number" &&
    typeof child.savingsGoal.targetAmount === "number" &&
    child.savingsGoal.targetAmount > 0 &&
    child.savingsGoal.currentAmount >= child.savingsGoal.targetAmount
  ) {
    award("saver");
  }
  if (juniorSignalsThisMonth >= 5) award("organized");
  if (streak >= 14) award("reliable");
  return newBadges;
}

async function handleJunior(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const juniorUserId = req.query?.userId;
  if (!juniorUserId) return res.status(400).json({ error: "userId required" });
  const ctx = await resolveJuniorContext(juniorUserId);
  if (!ctx?.householdId || !ctx.childRecord) {
    return res.status(404).json({
      ok: false,
      error: "junior_not_configured",
      message: "No junior crew member found for this userId.",
    });
  }
  const { householdId, childRecord } = ctx;
  const childName = childRecord.name || "";

  // Pull attributed signals + count this month's junior-source signals.
  const rawSignals = await redis.lrange(`household:${householdId}:signals`, 0, -1);
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const attributed = [];
  let juniorSignalsThisMonth = 0;
  for (const r of rawSignals || []) {
    const s = safeJson(r);
    if (!s) continue;
    const matchesChild =
      (s.crewMemberId && String(s.crewMemberId).toLowerCase() === childName.toLowerCase()) ||
      (s.userId === juniorUserId);
    if (matchesChild) attributed.push(s);
    if (
      s.source === "junior" &&
      s.createdAt &&
      s.createdAt >= monthStart.getTime()
    ) {
      juniorSignalsThisMonth += 1;
    }
  }

  const streak = calculateChoreStreak(childRecord.chores);
  const newBadges = evaluateBadges(childRecord, streak, juniorSignalsThisMonth);
  // Persist newly-earned badges back into the crew record so the
  // next read shows them even before any chore activity.
  if (newBadges.length > 0) {
    try {
      const rawCrew = await redis.get(`household:${householdId}:crew`);
      const crew = safeJson(rawCrew) || [];
      const idx = crew.findIndex(
        (m) =>
          m &&
          (m.juniorUserId === juniorUserId ||
            (m.name && m.name.toLowerCase() === childName.toLowerCase()))
      );
      if (idx >= 0) {
        crew[idx].badges = [...(crew[idx].badges || []), ...newBadges];
        await redis.set(`household:${householdId}:crew`, JSON.stringify(crew));
      }
    } catch (err) {
      console.warn("[junior] badge persist failed:", err?.message);
    }
  }

  return res.status(200).json({
    ok: true,
    household: householdId,
    name: childName,
    streak,
    chores: childRecord.chores || [],
    savingsGoal: childRecord.savingsGoal || null,
    allowanceWeekly: childRecord.allowanceWeekly || null,
    badges: [...(childRecord.badges || []), ...newBadges],
    badgesAvailable: BADGE_DEFINITIONS,
    attributedSignals: attributed.slice(0, 10),
    juniorSignalsThisMonth,
  });
}

async function handleJuniorRelay(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const { userId, description, category, urgency, voiceTranscript } = req.body || {};
  if (!userId) return res.status(400).json({ error: "userId required" });
  if (!description || !String(description).trim()) {
    return res.status(400).json({ error: "description required" });
  }
  const ctx = await resolveJuniorContext(userId);
  if (!ctx?.householdId || !ctx.childRecord) {
    return res.status(404).json({ error: "junior_not_configured" });
  }
  const { householdId, childRecord } = ctx;
  const childName = childRecord.name || "";

  if (category === "allowance_request") {
    // Pending allowance request — not a signal. Stored separately so
    // a parent can approve/reject via Settings or a future approval
    // surface.
    const request = {
      id: Date.now(),
      childName,
      childUserId: userId,
      description: String(description).trim(),
      voiceTranscript: voiceTranscript || null,
      requestedAt: new Date().toISOString(),
      status: "pending",
    };
    await redis.lpush(
      `household:${householdId}:juniorAllowanceRequests`,
      JSON.stringify(request)
    );
    return res.status(200).json({ ok: true, kind: "allowance_request", request });
  }

  const etaForUrgency = (() => {
    const now = new Date();
    if (urgency === "today") return now.toISOString().slice(0, 10);
    if (urgency === "this_week") {
      const d = new Date(now);
      d.setDate(d.getDate() + 5);
      return d.toISOString().slice(0, 10);
    }
    if (urgency === "soon") {
      const d = new Date(now);
      d.setDate(d.getDate() + 14);
      return d.toISOString().slice(0, 10);
    }
    return null;
  })();

  const tagPrefix = `[${childName.toUpperCase()} ADDED] `;
  const cleanDesc = String(description).trim().replace(/^\[.*?ADDED\]\s*/i, "");
  const signal = {
    id: Date.now(),
    description: tagPrefix + cleanDesc,
    type:
      category === "supply_needed" ? "supplies"
      : category === "school_info" ? "school"
      : category === "schedule_change" ? "schedule"
      : "junior",
    eta: etaForUrgency,
    sender: childName || "Junior",
    status: null,
    state: "incoming",
    source: "junior",
    crewMemberId: childName,
    userId,
    voiceTranscript: voiceTranscript || null,
    juniorCategory: category || "other",
    juniorUrgency: urgency || "soon",
    lastUpdate: new Date().toLocaleString(),
    createdAt: Date.now(),
  };
  await redis.lpush(`household:${householdId}:signals`, JSON.stringify(signal));

  // Bump signalsCreated counter on the child record so the badge
  // evaluator can fire "First signal" + "Organized".
  try {
    const rawCrew = await redis.get(`household:${householdId}:crew`);
    const crew = safeJson(rawCrew) || [];
    const idx = crew.findIndex(
      (m) =>
        m &&
        (m.juniorUserId === userId ||
          (m.name && m.name.toLowerCase() === childName.toLowerCase()))
    );
    if (idx >= 0) {
      crew[idx].signalsCreated = (crew[idx].signalsCreated || 0) + 1;
      await redis.set(`household:${householdId}:crew`, JSON.stringify(crew));
    }
  } catch (err) {
    console.warn("[junior] signalsCreated bump failed:", err?.message);
  }

  return res.status(201).json({ ok: true, household: householdId, signal });
}

async function handleJuniorVoice(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const { userId, transcript } = req.body || {};
  if (!userId) return res.status(400).json({ error: "userId required" });
  if (!transcript || !String(transcript).trim()) {
    return res.status(400).json({ error: "transcript required" });
  }
  const ctx = await resolveJuniorContext(userId);
  if (!ctx?.householdId || !ctx.childRecord) {
    return res.status(404).json({ error: "junior_not_configured" });
  }

  // Classify intent via Haiku tool_use.
  const prompt = `A child has spoken this into Conductor Junior. Classify the intent and extract details for the parent's household signal feed. Be charitable — children speak naturally.

Voice input: "${String(transcript).trim()}"

Return via the record_junior_intent tool.`;

  let parsed = null;
  try {
    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        tools: [
          {
            name: "record_junior_intent",
            description: "Classify a child's voice input.",
            input_schema: {
              type: "object",
              properties: {
                intent: {
                  type: "string",
                  enum: [
                    "need_supplies",
                    "schedule_change",
                    "school_info",
                    "allowance_request",
                    "chore_done",
                    "memory",
                    "other",
                  ],
                },
                description: { type: "string" },
                urgency: { type: "string", enum: ["today", "this_week", "soon"] },
                item: { type: ["string", "null"] },
                amount: { type: ["number", "null"] },
                isPositive: { type: "boolean" },
                choreName: { type: ["string", "null"] },
              },
              required: ["intent", "description", "urgency", "isPositive"],
            },
          },
        ],
        tool_choice: { type: "tool", name: "record_junior_intent" },
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (apiRes.ok) {
      const data = await apiRes.json();
      const tool = (data?.content || []).find((b) => b?.type === "tool_use");
      if (tool) parsed = tool.input;
    }
  } catch (err) {
    console.warn("[junior-voice] classify failed:", err?.message);
  }

  if (!parsed) {
    return res.status(502).json({ error: "voice classification failed" });
  }

  // Branch on intent. Memory + chore_done don't hit the parent feed.
  if (parsed.isPositive || parsed.intent === "memory") {
    const entry = {
      type: "junior_memory",
      childName: ctx.childRecord.name,
      description: parsed.description,
      voiceTranscript: String(transcript).trim(),
      createdAt: Date.now(),
      createdAtIso: new Date().toISOString(),
    };
    await redis.lpush(
      `household:${ctx.householdId}:memory`,
      JSON.stringify(entry)
    );
    return res.status(200).json({ ok: true, kind: "memory", entry });
  }

  if (parsed.intent === "chore_done" && parsed.choreName) {
    // Forward to chore-complete inline.
    req.body = {
      userId,
      choreName: parsed.choreName,
      completedDate: new Date().toISOString().slice(0, 10),
    };
    return handleChoreComplete(req, res);
  }

  // Otherwise create a relay signal.
  req.body = {
    userId,
    description: parsed.description,
    category:
      parsed.intent === "need_supplies" ? "supply_needed"
      : parsed.intent === "schedule_change" ? "schedule_change"
      : parsed.intent === "school_info" ? "school_info"
      : parsed.intent === "allowance_request" ? "allowance_request"
      : "other",
    urgency: parsed.urgency,
    voiceTranscript: String(transcript).trim(),
  };
  return handleJuniorRelay(req, res);
}

async function handleChoreComplete(req, res) {
  if (req.method !== "POST" && req.method !== "PATCH") {
    res.setHeader("Allow", "POST, PATCH");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const { userId, choreName, completedDate } = req.body || {};
  if (!userId) return res.status(400).json({ error: "userId required" });
  if (!choreName) return res.status(400).json({ error: "choreName required" });
  const ctx = await resolveJuniorContext(userId);
  if (!ctx?.householdId || !ctx.childRecord) {
    return res.status(404).json({ error: "junior_not_configured" });
  }
  const dayKey = (completedDate || new Date().toISOString()).slice(0, 10);

  const rawCrew = await redis.get(`household:${ctx.householdId}:crew`);
  const crew = safeJson(rawCrew) || [];
  const idx = crew.findIndex(
    (m) =>
      m &&
      (m.juniorUserId === userId ||
        (m.name && m.name.toLowerCase() === (ctx.childRecord.name || "").toLowerCase()))
  );
  if (idx < 0) {
    return res.status(404).json({ error: "junior_not_configured" });
  }
  const chores = Array.isArray(crew[idx].chores) ? crew[idx].chores : [];
  const choreIdx = chores.findIndex(
    (c) => c && c.name && c.name.toLowerCase() === String(choreName).toLowerCase()
  );
  if (choreIdx < 0) {
    return res.status(404).json({ error: "chore_not_found" });
  }
  const completed = new Set(chores[choreIdx].completedDates || []);
  completed.add(dayKey);
  chores[choreIdx].completedDates = Array.from(completed);
  crew[idx].chores = chores;
  await redis.set(`household:${ctx.householdId}:crew`, JSON.stringify(crew));

  const streak = calculateChoreStreak(chores);
  return res.status(200).json({
    ok: true,
    streak,
    chore: chores[choreIdx],
  });
}

// ---------- Household Profile ----------

const VALID_PROFILE_TYPES = new Set([
  "single",
  "couple",
  "family",
  "roommates",
  "multigenerational",
  "other",
]);

async function handleProfile(req, res) {
  const userId = req.method === "GET" ? req.query?.userId : req.body?.userId;
  if (!userId) return res.status(400).json({ error: "userId required" });
  const householdId = await resolveHouseholdId(userId);
  if (!householdId) return res.status(400).json({ error: "no household" });
  const key = `household:${householdId}:profile`;

  if (req.method === "GET") {
    const raw = await redis.get(key);
    const profile = safeJson(raw);
    return res.status(200).json({ ok: true, household: householdId, profile });
  }
  if (req.method === "POST") {
    const { type, ownOrRent, childrenCount, petsCount } = req.body || {};
    if (type && !VALID_PROFILE_TYPES.has(type)) {
      return res.status(400).json({ error: "invalid type" });
    }
    const existing = safeJson(await redis.get(key)) || {};
    const next = {
      ...existing,
      ...(type && { type }),
      ...(ownOrRent && { ownOrRent }),
      ...(childrenCount != null && { childrenCount: Number(childrenCount) }),
      ...(petsCount != null && { petsCount: Number(petsCount) }),
      setAt: new Date().toISOString(),
    };
    await redis.set(key, JSON.stringify(next));
    return res.status(200).json({ ok: true, household: householdId, profile: next });
  }
  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

// ---------- Privacy Dashboard ----------

async function handlePrivacy(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const userId = req.query?.userId;
  if (!userId) return res.status(400).json({ error: "userId required" });
  const householdId = await resolveHouseholdId(userId);
  if (!householdId) return res.status(400).json({ error: "no household" });

  // Best-effort counts — each is wrapped in try because some keys may
  // not exist for a brand-new household.
  const safeLen = async (k) => {
    try {
      const n = await redis.llen(k);
      return typeof n === "number" ? n : 0;
    } catch { return 0; }
  };
  const safeArrLen = async (k) => {
    try {
      const raw = await redis.get(k);
      const arr = safeJson(raw);
      return Array.isArray(arr) ? arr.length : 0;
    } catch { return 0; }
  };
  const safeSetLen = async (k) => {
    try {
      const n = await redis.scard(k);
      return typeof n === "number" ? n : 0;
    } catch { return 0; }
  };

  const [
    signalsFound,
    vaultItems,
    importedMessages,
    sentCommunications,
    networkConnections,
    crewCount,
  ] = await Promise.all([
    safeLen(`household:${householdId}:signals`),
    safeArrLen(`household:${householdId}:vault`).then(async (n) => {
      // Vault may also be a list — try both shapes.
      if (n) return n;
      return safeLen(`household:${householdId}:vault`);
    }),
    safeSetLen(`household:${householdId}:importedMessages`),
    safeLen(`household:${householdId}:sentCommunications`),
    safeSetLen(`household:${householdId}:networkConnections`),
    safeArrLen(`household:${householdId}:crew`),
  ]);

  // connectedSince — try user:{id}:profile or fall back to oldest signal.
  let connectedSince = null;
  try {
    const profile = safeJson(await redis.get(`user:${userId}:profile`));
    if (profile?.connectedAt) connectedSince = profile.connectedAt;
  } catch { /* skip */ }
  if (!connectedSince) {
    try {
      const raw = await redis.lrange(`household:${householdId}:signals`, -1, -1);
      const oldest = safeJson(raw?.[0]);
      if (oldest?.createdAt) connectedSince = new Date(oldest.createdAt).toISOString();
    } catch { /* skip */ }
  }

  // dataTypes — derived from which feature keys exist.
  const dataTypes = ["gmail", "calendar"];
  try {
    if (await redis.get(`user:${userId}:health`)) dataTypes.push("health");
  } catch { /* skip */ }
  try {
    if (await redis.get(`user:${userId}:oura:tokens`)) dataTypes.push("oura");
  } catch { /* skip */ }

  return res.status(200).json({
    ok: true,
    household: householdId,
    signalsFound,
    vaultItems,
    crewMembers: crewCount,
    emailsScanned: importedMessages,
    sentCommunications,
    networkConnections,
    connectedSince,
    dataTypes,
  });
}

// ---------- Founding Household / Referrals ----------

const REFERRAL_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateReferralCode() {
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += REFERRAL_ALPHABET[Math.floor(Math.random() * REFERRAL_ALPHABET.length)];
  }
  return out;
}

async function ensureReferralCode(householdId) {
  const key = `household:${householdId}:referralCode`;
  const existing = await redis.get(key);
  if (existing) return String(existing);
  let attempts = 0;
  while (attempts < 8) {
    const code = generateReferralCode();
    const taken = await redis.get(`referral:${code}`);
    if (!taken) {
      await redis.set(key, code);
      await redis.set(`referral:${code}`, householdId);
      return code;
    }
    attempts += 1;
  }
  // Extremely unlikely, but fall back to a longer code on collision.
  const fallback = generateReferralCode() + Date.now().toString(36).slice(-4).toUpperCase();
  await redis.set(key, fallback);
  await redis.set(`referral:${fallback}`, householdId);
  return fallback;
}

async function handleReferral(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const userId = req.query?.userId;
  if (!userId) return res.status(400).json({ error: "userId required" });
  const householdId = await resolveHouseholdId(userId);
  if (!householdId) return res.status(400).json({ error: "no household" });

  // Founding household detection — if not already flagged, check the
  // count of all households and mark this one as founding if it's
  // one of the first 50.
  const flagKey = `household:${householdId}:foundingHousehold`;
  const freeUntilKey = `household:${householdId}:freeUntil`;
  let founding = (await redis.get(flagKey)) === "1";
  let freeUntil = await redis.get(freeUntilKey);

  if (!founding && !freeUntil) {
    try {
      // Approximate global count via SCARD on a registry set if it
      // exists; otherwise just opt this household in. The 50-cap is
      // best-effort — a future cron can prune outliers.
      const count = await redis.scard("households:registry").catch(() => 0);
      const isFounding = (count || 0) < 50;
      if (isFounding) {
        founding = true;
        const six = new Date();
        six.setMonth(six.getMonth() + 6);
        freeUntil = six.toISOString();
        await redis.set(flagKey, "1");
        await redis.set(freeUntilKey, freeUntil);
      }
      try { await redis.sadd("households:registry", householdId); } catch { /* skip */ }
    } catch (err) {
      console.warn("[referral] founding check failed:", err?.message);
    }
  }

  const code = await ensureReferralCode(householdId);
  const count = parseInt(
    (await redis.get(`household:${householdId}:referralCount`)) || "0",
    10
  ) || 0;
  const freeMonthsEarned = count; // 30 days per referral, simplified as months

  return res.status(200).json({
    ok: true,
    referralCode: code,
    referralCount: count,
    freeMonthsEarned,
    foundingHousehold: founding,
    freeUntil: freeUntil || null,
  });
}

async function handleReferralJoin(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const { referralCode, newHouseholdId } = req.body || {};
  if (!referralCode) return res.status(400).json({ error: "referralCode required" });
  if (!newHouseholdId) return res.status(400).json({ error: "newHouseholdId required" });

  const referringHouseholdId = await redis.get(`referral:${String(referralCode).toUpperCase()}`);
  if (!referringHouseholdId) {
    return res.status(404).json({ ok: false, error: "invalid referral code" });
  }

  // Increment referrer's count + extend freeUntil by 30 days.
  const countKey = `household:${referringHouseholdId}:referralCount`;
  const currentCount = parseInt((await redis.get(countKey)) || "0", 10) || 0;
  await redis.set(countKey, String(currentCount + 1));

  const freeKey = `household:${referringHouseholdId}:freeUntil`;
  const existingFreeUntil = await redis.get(freeKey);
  const baseDate = existingFreeUntil ? new Date(existingFreeUntil) : new Date();
  if (isNaN(baseDate.getTime())) baseDate.setTime(Date.now());
  baseDate.setDate(baseDate.getDate() + 30);
  await redis.set(freeKey, baseDate.toISOString());

  // Mark new household as referred.
  await redis.set(`household:${newHouseholdId}:referredBy`, String(referralCode).toUpperCase());

  return res.status(200).json({
    ok: true,
    referringHouseholdId,
    referrerNewFreeUntil: baseDate.toISOString(),
  });
}

// ---------- Account Deletion + Export ----------

const DELETE_CONFIRMATION_PHRASE = "delete my account";

const HOUSEHOLD_KEY_SUFFIXES = [
  "signals",
  "vault",
  "crew",
  "memory",
  "patterns",
  "inventory",
  "providers",
  "transactions",
  "maintenancePlan",
  "streakData",
  "networkConnections",
  "calendar",
  "horizon",
  "weeklyGoals",
  "importedMessages",
  "contentFingerprints",
  "sentCommunications",
  "contacts",
  "profile",
  "firstBriefSent",
  "foundingHousehold",
  "freeUntil",
  "referralCount",
  "referralCode",
  "referredBy",
  "juniorAllowanceRequests",
  "anniversaryAcknowledged",
];

async function handleDeleteAccount(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const { userId, confirmationPhrase } = req.body || {};
  if (!userId) return res.status(400).json({ error: "userId required" });
  if (
    !confirmationPhrase ||
    String(confirmationPhrase).trim().toLowerCase() !== DELETE_CONFIRMATION_PHRASE
  ) {
    return res.status(400).json({
      error: "confirmation_phrase_required",
      expected: DELETE_CONFIRMATION_PHRASE,
    });
  }
  const householdId = await resolveHouseholdId(userId);
  if (!householdId) return res.status(400).json({ error: "no household" });

  // Best-effort, idempotent deletion. Errors on any single key are
  // logged but don't abort — better to clear most than refuse to
  // delete on a stuck key.
  const deletions = {};
  for (const suffix of HOUSEHOLD_KEY_SUFFIXES) {
    const key = `household:${householdId}:${suffix}`;
    try { deletions[key] = await redis.del(key); } catch { deletions[key] = "err"; }
  }
  // Per-user keys.
  const userKeys = [
    `user:${userId}:tokens`,
    `user:${userId}:profile`,
    `user:${userId}:household`,
    `user:${userId}:preferences`,
    `user:${userId}:currentTakeoff`,
    `user:${userId}:health`,
    `user:${userId}:pushToken`,
    `user:${userId}:oura:tokens`,
    `user:${userId}:oura:settings`,
  ];
  for (const key of userKeys) {
    try { deletions[key] = await redis.del(key); } catch { deletions[key] = "err"; }
  }
  // Drop the household from the registry.
  try { await redis.srem("households:registry", householdId); } catch { /* skip */ }

  return res.status(200).json({
    ok: true,
    deleted: true,
    deletions,
  });
}

async function handlePriorities(req, res) {
  const userId = req.method === "GET" ? req.query?.userId : req.body?.userId;
  if (!userId) return res.status(400).json({ error: "userId required" });
  const householdId = await resolveHouseholdId(userId);
  if (!householdId) return res.status(400).json({ error: "no household" });
  const key = `household:${householdId}:priorities`;
  if (req.method === "GET") {
    const raw = await redis.get(key);
    return res.status(200).json({ ok: true, priorities: safeJson(raw) || [] });
  }
  if (req.method === "POST") {
    const { priorities } = req.body || {};
    if (!Array.isArray(priorities)) {
      return res.status(400).json({ error: "priorities (array) required" });
    }
    const sanitized = priorities
      .map((p) => (typeof p === "string" ? p.trim() : null))
      .filter(Boolean);
    await redis.set(key, JSON.stringify({
      values: sanitized,
      setAt: new Date().toISOString(),
    }));
    return res.status(200).json({ ok: true, household: householdId, priorities: sanitized });
  }
  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

async function handleExport(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const userId = req.query?.userId;
  if (!userId) return res.status(400).json({ error: "userId required" });
  const householdId = await resolveHouseholdId(userId);
  if (!householdId) return res.status(400).json({ error: "no household" });

  const safeList = async (k) => {
    try {
      const raw = await redis.lrange(k, 0, -1);
      return (raw || []).map((r) => safeJson(r)).filter(Boolean);
    } catch { return []; }
  };
  const safeGetJson = async (k) => {
    try {
      const raw = await redis.get(k);
      return safeJson(raw);
    } catch { return null; }
  };

  const [
    signals,
    memory,
    patterns,
    transactions,
    sentCommunications,
    vault,
    crew,
    inventory,
    providers,
    streakData,
    maintenancePlan,
    profile,
    contacts,
  ] = await Promise.all([
    safeList(`household:${householdId}:signals`),
    safeList(`household:${householdId}:memory`),
    safeList(`household:${householdId}:patterns`),
    safeList(`household:${householdId}:transactions`),
    safeList(`household:${householdId}:sentCommunications`),
    safeGetJson(`household:${householdId}:vault`),
    safeGetJson(`household:${householdId}:crew`),
    safeGetJson(`household:${householdId}:inventory`),
    safeGetJson(`household:${householdId}:providers`),
    safeGetJson(`household:${householdId}:streakData`),
    safeGetJson(`household:${householdId}:maintenancePlan`),
    safeGetJson(`household:${householdId}:profile`),
    safeGetJson(`household:${householdId}:contacts`),
  ]);

  const payload = {
    exportedAt: new Date().toISOString(),
    householdId,
    userId,
    profile,
    signals,
    vault,
    crew,
    memory,
    patterns,
    inventory,
    providers,
    transactions,
    streakData,
    maintenancePlan,
    sentCommunications,
    contacts,
  };

  res.setHeader("Content-Type", "application/json");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="conductor-export-${householdId}-${Date.now()}.json"`
  );
  return res.status(200).send(JSON.stringify(payload, null, 2));
}

async function handleCamouflage(req, res) {
  if (req.method === "GET") {
    const householdId = await resolveHouseholdId(req.query?.userId);
    const rules = await loadCamouflageRules(householdId);
    return res.status(200).json({ household: householdId, rules });
  }

  if (req.method === "POST") {
    let { userId, ruleType, value } = req.body || {};
    const { signalId } = req.body || {};
    if (!userId) return res.status(400).json({ error: "userId required" });

    // Mobile quick-action "Not relevant" passes just { userId, signalId }
    // — derive the sender from the named signal so the camouflage rule
    // suppresses future imports from the same source.
    if (signalId != null && (!ruleType || !value)) {
      const hid = await resolveHouseholdId(userId);
      const raw = await redis.lrange(`household:${hid}:signals`, 0, -1);
      let foundSender = null;
      for (const r of raw || []) {
        try {
          const s = typeof r === "string" ? JSON.parse(r) : r;
          if (s && (s.id === signalId || String(s.id) === String(signalId))) {
            foundSender = s.sender || null;
            break;
          }
        } catch {
          // skip malformed
        }
      }
      if (foundSender) {
        ruleType = "sender";
        value = foundSender;
      } else {
        return res.status(404).json({ error: "signalId not found" });
      }
    }

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

    // Handoff acknowledgment — POST to mark a handoff as covered
    // by a household member. Suppresses the HANDOFF prompt line in
    // subsequent briefs for ~36h (see brief.js ackedSignalIds).
    if (queryType === "handoff" || bodyType === "handoff") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return res.status(405).json({ error: "Method not allowed for handoff" });
      }
      const { signalId, acknowledgedBy, userId: bodyUserId } = req.body || {};
      if (!signalId) return res.status(400).json({ error: "signalId required" });
      const householdId = await resolveHouseholdId(bodyUserId || acknowledgedBy);
      if (!householdId) return res.status(400).json({ error: "Could not resolve household" });
      const record = {
        signalId: String(signalId),
        acknowledgedBy: acknowledgedBy || bodyUserId || null,
        acknowledgedAt: new Date().toISOString(),
      };
      await redis.hset(`household:${householdId}:handoffsAck`, {
        [String(signalId)]: JSON.stringify(record),
      });
      return res.status(200).json({ ok: true, household: householdId, ...record });
    }

    // Crew photo upload — accepts a base64-encoded image, persists
    // it to Vercel Blob, and patches the crew member record with
    // the resulting public URL. Blob storage must be provisioned on
    // the Vercel project (BLOB_READ_WRITE_TOKEN is auto-injected
    // when Blob is attached). Returns { photoUrl } on success.
    if (queryType === "crew-photo" || bodyType === "crew-photo") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return res.status(405).json({ error: "Method not allowed for crew-photo" });
      }
      const { userId, crewMemberName, memberType, photo } = req.body || {};
      if (!userId) return res.status(400).json({ error: "userId required" });
      if (!crewMemberName) return res.status(400).json({ error: "crewMemberName required" });
      if (!photo || typeof photo !== "string") {
        return res.status(400).json({ error: "photo (base64 string) required" });
      }
      let blobMod;
      try {
        blobMod = await import("@vercel/blob");
      } catch (err) {
        return res.status(500).json({ error: "Blob storage unavailable", message: err?.message });
      }
      const householdId = await resolveHouseholdId(userId);
      // Strip data URL prefix if present (data:image/jpeg;base64,...).
      const b64 = photo.replace(/^data:image\/[a-z]+;base64,/i, "");
      let buffer;
      try {
        buffer = Buffer.from(b64, "base64");
      } catch {
        return res.status(400).json({ error: "Invalid base64 payload" });
      }
      const normalizedName = String(crewMemberName)
        .toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const blobKey = `crew/${householdId}/${normalizedName}-${Date.now()}.jpg`;
      let putResult;
      try {
        // Private blob — the returned URL requires the read token to
        // fetch, so mobile can't use it directly. We store the
        // pathname and serve a signed proxy URL via ?type=crew-photo-fetch
        // (see signedPhotoUrl below). The Vercel Blob SDK does not
        // currently expose a generateSignedUrl with expiresIn, so we
        // implement HMAC-signed expiring URLs ourselves.
        putResult = await blobMod.put(blobKey, buffer, {
          access: "private",
          contentType: "image/jpeg",
        });
      } catch (err) {
        console.error("[crew-photo] blob put failed:", err);
        return res.status(500).json({ error: "Photo upload failed", message: err?.message });
      }
      const blobUrl = putResult?.url || null;
      const pathname = putResult?.pathname || blobKey;
      if (!blobUrl) return res.status(500).json({ error: "Blob returned no URL" });

      // Patch the crew member record in place. We persist BOTH the
      // raw blobUrl (server-side proxy fetches from this) and the
      // pathname (used as the input to the HMAC signing). The
      // photoUrl returned to clients is the signed proxy URL.
      try {
        const crewKey = `household:${householdId}:crew`;
        const rawCrew = await redis.get(crewKey);
        const crew = Array.isArray(safeJson(rawCrew)) ? safeJson(rawCrew) : [];
        const idx = crew.findIndex(
          (m) =>
            m &&
            m.name &&
            m.name.toLowerCase().trim() === crewMemberName.toLowerCase().trim() &&
            (!memberType || m.memberType === memberType)
        );
        if (idx >= 0) {
          crew[idx].photoBlobUrl = blobUrl;
          crew[idx].photoBlobPathname = pathname;
          // Drop legacy public photoUrl if present — it's replaced
          // by the signed proxy URL on subsequent GETs.
          delete crew[idx].photoUrl;
          await redis.set(crewKey, JSON.stringify(crew));
        }
      } catch (err) {
        console.warn("[crew-photo] crew update failed:", err?.message);
      }
      const signedUrl = signedPhotoUrl(householdId, pathname);
      return res.status(200).json({ ok: true, household: householdId, photoUrl: signedUrl });
    }

    // Signed-URL proxy endpoint — validates HMAC + expiry, then
    // streams the private blob bytes through with appropriate
    // Content-Type. Token is a hex HMAC of (householdId + pathname +
    // expiresAt) using BLOB_READ_WRITE_TOKEN as the secret. Anyone
    // with a valid (un-expired) URL can fetch the photo — same
    // semantics as cloud-provider signed URLs.
    if (queryType === "crew-photo-fetch") {
      const { hid, p: pathname, e: expiresAtStr, s: sig } = req.query || {};
      if (!hid || !pathname || !expiresAtStr || !sig) {
        return res.status(400).json({ error: "missing token params" });
      }
      const expiresAt = parseInt(String(expiresAtStr), 10);
      if (!Number.isFinite(expiresAt)) return res.status(400).json({ error: "bad expiresAt" });
      if (Date.now() > expiresAt) return res.status(410).json({ error: "URL expired" });
      const expected = signPhotoToken(String(hid), String(pathname), expiresAt);
      if (expected !== sig) return res.status(403).json({ error: "bad signature" });
      // Resolve the blob to its current URL via head() — the URL is
      // stable but head() also gives us the contentType.
      let blobMod;
      try {
        blobMod = await import("@vercel/blob");
      } catch (err) {
        return res.status(500).json({ error: "Blob unavailable", message: err?.message });
      }
      let meta;
      try {
        meta = await blobMod.head(String(pathname));
      } catch (err) {
        console.error("[crew-photo-fetch] head failed:", err);
        return res.status(404).json({ error: "blob not found" });
      }
      // For private blobs, fetching the URL server-side requires the
      // token in the Authorization header. The SDK exposes the token
      // via BLOB_READ_WRITE_TOKEN env (auto-injected on Vercel).
      const token = process.env.BLOB_READ_WRITE_TOKEN;
      let blobRes;
      try {
        blobRes = await fetch(meta.url, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
      } catch (err) {
        return res.status(502).json({ error: "blob fetch failed", message: err?.message });
      }
      if (!blobRes.ok) {
        return res.status(blobRes.status).json({ error: "blob fetch non-2xx" });
      }
      const arrayBuf = await blobRes.arrayBuffer();
      res.setHeader("Content-Type", meta.contentType || "image/jpeg");
      res.setHeader("Cache-Control", "private, max-age=3600");
      return res.status(200).send(Buffer.from(arrayBuf));
    }

    // Crew attribution — record that a signal belongs to a specific
    // crew member, AND add the sender to that crew member's
    // senderPatterns so future imports auto-attribute. Two-way bind.
    if (queryType === "crew-attribution" || bodyType === "crew-attribution") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return res.status(405).json({ error: "Method not allowed for crew-attribution" });
      }
      const { userId, signalId, crewMemberName } = req.body || {};
      if (!userId) return res.status(400).json({ error: "userId required" });
      if (signalId == null) return res.status(400).json({ error: "signalId required" });
      const householdId = await resolveHouseholdId(userId);

      // 1. Stamp crewMemberId on the signal. Search :signals list,
      //    then :deadlines for vault-derived items.
      const sigKey = `household:${householdId}:signals`;
      const rawSigs = await redis.lrange(sigKey, 0, -1);
      let updatedSignal = null;
      let updatedSender = null;
      for (let i = 0; i < rawSigs.length; i++) {
        const s = safeJson(rawSigs[i]);
        if (!s || (s.id !== signalId && String(s.id) !== String(signalId))) continue;
        if (crewMemberName) {
          s.crewMemberId = crewMemberName;
        } else {
          delete s.crewMemberId;
        }
        await redis.lset(sigKey, i, JSON.stringify(s));
        updatedSignal = s;
        updatedSender = s.sender || null;
        break;
      }
      if (!updatedSignal) {
        return res.status(404).json({ error: "signalId not found" });
      }

      // 2. Add the sender to the crew member's senderPatterns so
      //    future imports auto-attribute. Best-effort — skip if the
      //    crew member can't be found by name.
      if (crewMemberName && updatedSender) {
        try {
          const crewKey = `household:${householdId}:crew`;
          const rawCrew = await redis.get(crewKey);
          const crew = Array.isArray(safeJson(rawCrew)) ? safeJson(rawCrew) : [];
          const idx = crew.findIndex(
            (m) => m && m.name && m.name.toLowerCase().trim() === crewMemberName.toLowerCase().trim()
          );
          if (idx >= 0) {
            const cur = Array.isArray(crew[idx].senderPatterns) ? crew[idx].senderPatterns : [];
            if (!cur.includes(updatedSender)) {
              crew[idx].senderPatterns = [...cur, updatedSender];
              await redis.set(crewKey, JSON.stringify(crew));
            }
          }
        } catch (err) {
          console.warn("[crew-attribution] senderPatterns update failed:", err?.message);
        }
      }
      return res.status(200).json({ ok: true, household: householdId, signal: updatedSignal });
    }

    // Year in Review fetch — returns the persisted prose for the
    // requested year, or null when none exists. Useful for the mobile
    // "View past years" affordance on the Memory Journal.
    if (queryType === "yearInReview") {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        return res.status(405).json({ error: "Method not allowed for yearInReview" });
      }
      const householdId = await resolveHouseholdId(req.query?.userId);
      if (!householdId) return res.status(400).json({ error: "userId required" });
      const yearParam = req.query?.year;
      const year = yearParam ? parseInt(yearParam, 10) : null;
      // No year → return list of years we have on file. Scan the
      // yearInReview:* keys for this household; tiny set, fast match.
      if (!year) {
        const keys = [];
        let cursor = "0";
        do {
          const [next, batch] = await redis.scan(cursor, {
            match: `household:${householdId}:yearInReview:*`,
            count: 100,
          });
          cursor = next;
          if (batch?.length) keys.push(...batch);
        } while (cursor !== "0" && cursor !== 0);
        const years = keys
          .map((k) => parseInt(k.split(":").pop(), 10))
          .filter((n) => Number.isFinite(n))
          .sort((a, b) => b - a);
        return res.status(200).json({ household: householdId, years });
      }
      const text = await redis.get(`household:${householdId}:yearInReview:${year}`);
      return res.status(200).json({
        household: householdId,
        year,
        yearInReview: typeof text === "string" ? text : null,
      });
    }

    // Conductor question ack — fire-and-forget telemetry. Records
    // which question got which response so future versions can tune
    // generation. Dismissed/acknowledged tracking lives client-side
    // in AsyncStorage (per spec) so this endpoint is best-effort.
    if (queryType === "conductorQuestion" || bodyType === "conductorQuestion") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return res.status(405).json({ error: "Method not allowed for conductorQuestion" });
      }
      const { userId: bodyUserId, question, response } = req.body || {};
      const householdId = await resolveHouseholdId(bodyUserId);
      if (!householdId) return res.status(400).json({ error: "userId required" });
      const record = {
        question: typeof question === "string" ? question : null,
        response: response === "dismissed" ? "dismissed" : "acknowledged",
        at: new Date().toISOString(),
      };
      await redis.lpush(`household:${householdId}:conductorQuestionLog`, JSON.stringify(record));
      await redis.ltrim(`household:${householdId}:conductorQuestionLog`, 0, 99);
      return res.status(200).json({ ok: true, household: householdId, ...record });
    }

    // Inventory suggestions — read unconfirmed records produced by
    // onboard's inventory job (or by import.js's per-email extraction
    // when it lands). Mobile renders these in a "CONDUCTOR FOUND"
    // section so the user can one-tap-confirm or edit before merging
    // into the canonical household:{id}:inventory store.
    if (queryType === "inventorySuggestions") {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        return res.status(405).json({ error: "Method not allowed for inventorySuggestions" });
      }
      const householdId = await resolveHouseholdId(req.query?.userId);
      if (!householdId) return res.status(400).json({ error: "userId required" });
      const raw = await redis.lrange(
        `household:${householdId}:inventorySuggestions`,
        0, -1
      );
      const items = (raw || [])
        .map(safeJson)
        .filter(Boolean)
        .filter((s) => !s.confirmed && !s.dismissed);
      return res.status(200).json({
        household: householdId,
        count: items.length,
        items,
      });
    }

    // Confirm or reject an inventory suggestion. Confirmed entries
    // get merged into household:{id}:inventory under the appropriate
    // category bucket; rejected entries get marked dismissed so they
    // don't reappear in the GET above.
    if (queryType === "confirmInventory" || bodyType === "confirmInventory") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return res.status(405).json({ error: "Method not allowed for confirmInventory" });
      }
      const { userId: bodyUserId, suggestionId, confirmed, updates } = req.body || {};
      if (!bodyUserId) return res.status(400).json({ error: "userId required" });
      if (!suggestionId) return res.status(400).json({ error: "suggestionId required" });
      const householdId = await resolveHouseholdId(bodyUserId);
      const key = `household:${householdId}:inventorySuggestions`;
      const raw = await redis.lrange(key, 0, -1);
      let target = null;
      let targetRaw = null;
      let idx = -1;
      for (let i = 0; i < raw.length; i++) {
        const p = safeJson(raw[i]);
        if (p && (p.id === suggestionId || String(p.id) === String(suggestionId))) {
          target = p;
          targetRaw = raw[i];
          idx = i;
          break;
        }
      }
      if (!target) return res.status(404).json({ error: "suggestion not found" });

      // Apply any inline edits the user made on the confirmation
      // card before tapping "Looks right".
      const ALLOWED = [
        "itemType", "brand", "model", "year", "installDate",
        "lastServiceDate", "lastServiceMileage", "filterSize", "serialNumber",
      ];
      const merged = { ...target };
      if (updates && typeof updates === "object") {
        for (const k of ALLOWED) {
          if (Object.prototype.hasOwnProperty.call(updates, k)) {
            merged[k] = updates[k];
          }
        }
      }

      if (confirmed === false) {
        merged.dismissed = true;
        merged.dismissedAt = new Date().toISOString();
        await redis.lset(key, idx, JSON.stringify(merged));
        return res.status(200).json({ ok: true, dismissed: true });
      }

      // Confirmed path — merge into :inventory honoring its
      // legacy schema (single-object slots for roof/hvac/waterHeater/
      // electrical, arrays for vehicles/appliances). Field-name
      // mapping bridges the suggestion shape (brand/year/...) to the
      // canonical inventory shape that the mobile renderer expects.
      merged.confirmed = true;
      merged.confirmedAt = new Date().toISOString();
      delete merged.suggested;
      await redis.lset(key, idx, JSON.stringify(merged));

      const invKey = `household:${householdId}:inventory`;
      const invRaw = await redis.get(invKey);
      const inv = (() => {
        const p = safeJson(invRaw);
        return p && typeof p === "object" && !Array.isArray(p) ? p : {};
      })();

      const fromEmail = true;
      const yearStr = merged.year != null ? String(merged.year) : null;
      const t = String(merged.itemType || "other").toLowerCase();
      let bucket = t;
      if (t === "hvac") {
        inv.hvac = {
          ...(inv.hvac && !Array.isArray(inv.hvac) ? inv.hvac : {}),
          brand: merged.brand ?? inv.hvac?.brand ?? null,
          yearInstalled: yearStr ?? inv.hvac?.yearInstalled ?? null,
          lastServiced: merged.lastServiceDate ?? inv.hvac?.lastServiced ?? null,
          filterSize: merged.filterSize ?? inv.hvac?.filterSize ?? null,
          fromEmail,
        };
      } else if (t === "roof") {
        inv.roof = {
          ...(inv.roof && !Array.isArray(inv.roof) ? inv.roof : {}),
          material: merged.brand ?? inv.roof?.material ?? null,
          yearInstalled: yearStr ?? inv.roof?.yearInstalled ?? null,
          lastInspected: merged.lastServiceDate ?? inv.roof?.lastInspected ?? null,
          fromEmail,
        };
      } else if (t === "water_heater") {
        bucket = "waterHeater";
        inv.waterHeater = {
          ...(inv.waterHeater && !Array.isArray(inv.waterHeater) ? inv.waterHeater : {}),
          yearInstalled: yearStr ?? inv.waterHeater?.yearInstalled ?? null,
          type: merged.brand ?? inv.waterHeater?.type ?? null,
          fromEmail,
        };
      } else if (t === "electrical") {
        inv.electrical = {
          ...(inv.electrical && !Array.isArray(inv.electrical) ? inv.electrical : {}),
          panelAmps: inv.electrical?.panelAmps ?? null,
          yearUpdated: yearStr ?? inv.electrical?.yearUpdated ?? null,
          fromEmail,
        };
      } else if (t === "vehicle") {
        bucket = "vehicles";
        const arr = Array.isArray(inv.vehicles) ? inv.vehicles : [];
        arr.push({
          make: merged.brand ?? null,
          model: merged.model ?? null,
          year: yearStr,
          mileage: merged.lastServiceMileage != null ? String(merged.lastServiceMileage) : null,
          lastService: merged.lastServiceDate ?? null,
          fromEmail,
        });
        inv.vehicles = arr;
      } else if (t === "appliance") {
        bucket = "appliances";
        const arr = Array.isArray(inv.appliances) ? inv.appliances : [];
        const name = [merged.brand, merged.model].filter(Boolean).join(" ").trim()
          || merged.sourceDescription
          || "Appliance";
        arr.push({
          name,
          yearPurchased: yearStr,
          fromEmail,
        });
        inv.appliances = arr;
      } else {
        // Bucketless — preserve under inv.other[] so nothing is lost
        // even though no current mobile section renders it.
        bucket = "other";
        const arr = Array.isArray(inv.other) ? inv.other : [];
        arr.push({ ...merged, fromEmail, addedAt: new Date().toISOString() });
        inv.other = arr;
      }

      await redis.set(invKey, JSON.stringify(inv));
      return res.status(200).json({ ok: true, household: householdId, bucket, inventory: inv });
    }

    // Auto-resolutions — surfaces what Conductor handled without
    // user action over the last 48h (default). Reads the memory log
    // for resolved/expired entries within the window. Source
    // 'tracking' (carrier auto-resolves) gets a wasAutomatic flag.
    if (queryType === "autoResolutions") {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        return res.status(405).json({ error: "Method not allowed for autoResolutions" });
      }
      const householdId = await resolveHouseholdId(req.query?.userId);
      if (!householdId) return res.status(400).json({ error: "userId required" });
      const sinceParam = req.query?.since;
      const sinceMs = sinceParam ? Date.parse(sinceParam) : NaN;
      const windowStart = !isNaN(sinceMs)
        ? sinceMs
        : Date.now() - 48 * 60 * 60 * 1000;

      const raw = await redis.lrange(`household:${householdId}:memory`, 0, -1);
      const items = [];
      for (const r of raw || []) {
        try {
          const e = typeof r === "string" ? JSON.parse(r) : r;
          if (!e) continue;
          if (e.action !== "resolved" && e.action !== "expired") continue;
          const ms = Date.parse(e.actionAt || "");
          if (isNaN(ms) || ms < windowStart) continue;
          items.push({
            signalId: e.signalId,
            description: e.description,
            sender: e.sender,
            type: e.type,
            action: e.action,
            resolvedAt: e.actionAt,
            wasAutomatic:
              e.source === "tracking" ||
              e.source === "cron" ||
              e.source === "auto" ||
              e.action === "expired",
          });
        } catch {
          // skip malformed entry
        }
      }
      return res.status(200).json({
        household: householdId,
        count: items.length,
        items,
      });
    }

    // Memory journal — full longitudinal view of the household's
    // memory log, grouped by ET date. Caught moments are joined in
    // from the dedicated list so the mobile screen can mark them
    // with a brass border + badge.
    if (queryType === "journal") {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        return res.status(405).json({ error: "Method not allowed for journal" });
      }
      const householdId = await resolveHouseholdId(req.query?.userId);
      if (!householdId) return res.status(400).json({ error: "userId required" });
      const days = Math.max(1, Math.min(180, parseInt(req.query?.days || "30", 10) || 30));
      const windowStart = Date.now() - days * 24 * 60 * 60 * 1000;

      const [rawMemory, rawStreak, rawCaught] = await Promise.all([
        redis.lrange(`household:${householdId}:memory`, 0, -1),
        redis.get(`household:${householdId}:streakData`),
        redis.lrange(`household:${householdId}${CAUGHT_MOMENTS_KEY_SUFFIX}`, 0, -1),
      ]);

      // Build caught-moment lookup: a memory entry counts as a
      // caught moment if a record exists in :caughtMoments within
      // 72h of the entry's actionAt with a matching signalId.
      const SEVENTY_TWO_H = 72 * 60 * 60 * 1000;
      const caught = (rawCaught || [])
        .map((r) => { try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; } })
        .filter(Boolean);

      const byDate = new Map();
      for (const r of rawMemory || []) {
        let e;
        try { e = typeof r === "string" ? JSON.parse(r) : r; } catch { continue; }
        if (!e || !e.actionAt) continue;
        const ms = Date.parse(e.actionAt);
        if (isNaN(ms) || ms < windowStart) continue;
        const dateKey = new Date(ms).toLocaleDateString("en-US", {
          timeZone: "America/New_York",
          year: "numeric", month: "2-digit", day: "numeric",
        });
        const isCaughtMoment = caught.some(
          (c) =>
            c &&
            (c.id === e.signalId || String(c.id) === String(e.signalId)) &&
            Math.abs(Date.parse(c.resolvedAt || "") - ms) < SEVENTY_TWO_H
        );
        const wasAutomatic =
          e.source === "tracking" ||
          e.source === "cron" ||
          e.source === "auto" ||
          e.action === "expired";
        const enriched = {
          signalId: e.signalId,
          description: e.description,
          sender: e.sender,
          type: e.type,
          action: e.action,
          actionAt: e.actionAt,
          userId: e.userId,
          isCaughtMoment,
          wasAutomatic,
        };
        if (!byDate.has(dateKey)) byDate.set(dateKey, []);
        byDate.get(dateKey).push(enriched);
      }

      const sortedDays = [...byDate.entries()]
        .sort((a, b) => Date.parse(b[0]) - Date.parse(a[0]))
        .map(([date, entries]) => ({ date, entries }));

      return res.status(200).json({
        household: householdId,
        days: sortedDays,
        streakData: (() => { try { return typeof rawStreak === "string" ? JSON.parse(rawStreak) : rawStreak; } catch { return null; } })(),
      });
    }

    // Streak — read household streakData. Returns the persisted
    // counters even when zero so the mobile card can render an
    // empty-state without a separate code path.
    if (queryType === "streak") {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        return res.status(405).json({ error: "Method not allowed for streak" });
      }
      const householdId = await resolveHouseholdId(req.query?.userId);
      if (!householdId) return res.status(400).json({ error: "userId required" });
      const raw = await redis.get(`household:${householdId}:streakData`);
      const data = safeJson(raw) || {
        currentStreak: 0,
        longestStreak: 0,
        lastResolutionDate: null,
        totalResolved: 0,
        streakStartDate: null,
      };
      return res.status(200).json({ household: householdId, streak: data });
    }

    // Threads — read thread metadata for a specific threadId. GET
    // returns the thread record plus the full signal objects for
    // each member. Mobile Hover / Finale use this for the
    // "Part of: {summary}" header + "View thread" list.
    if (queryType === "thread") {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        return res.status(405).json({ error: "Method not allowed for thread" });
      }
      const threadId = req.query?.threadId;
      if (!threadId) return res.status(400).json({ error: "threadId required" });
      const householdId = await resolveHouseholdId(req.query?.userId);
      const raw = await redis.get(`household:${householdId}:threads:${threadId}`);
      const meta = safeJson(raw);
      if (!meta) return res.status(404).json({ error: "thread not found" });

      // Resolve member signal objects from the household signal list.
      const memberIds = new Set((meta.signals || []).map(String));
      const rawSignals = await redis.lrange(`household:${householdId}:signals`, 0, -1);
      const members = [];
      for (const r of rawSignals || []) {
        try {
          const s = typeof r === "string" ? JSON.parse(r) : r;
          if (s && memberIds.has(String(s.id))) members.push(s);
        } catch { /* skip */ }
      }
      return res.status(200).json({ household: householdId, thread: meta, members });
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

    // Junior — child interface aggregate. Returns chores + streak +
    // savings + badges + attributed signals for the requesting child.
    // The child's userId is the same key as the parent's view, but
    // the response is shaped for the child UI.
    if (queryType === "junior") {
      return handleJunior(req, res);
    }

    if (queryType === "junior-relay" || bodyType === "junior-relay") {
      return handleJuniorRelay(req, res);
    }

    if (queryType === "junior-voice" || bodyType === "junior-voice") {
      return handleJuniorVoice(req, res);
    }

    if (queryType === "chore-complete" || bodyType === "chore-complete") {
      return handleChoreComplete(req, res);
    }

    if (queryType === "profile" || bodyType === "profile") {
      return handleProfile(req, res);
    }

    if (queryType === "privacy") {
      return handlePrivacy(req, res);
    }

    if (queryType === "referral") {
      return handleReferral(req, res);
    }

    if (queryType === "referral-join" || bodyType === "referral-join") {
      return handleReferralJoin(req, res);
    }

    if (queryType === "delete-account" || bodyType === "delete-account") {
      return handleDeleteAccount(req, res);
    }

    if (queryType === "export") {
      return handleExport(req, res);
    }

    if (queryType === "priorities" || bodyType === "priorities") {
      return handlePriorities(req, res);
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
          if (state === "snoozed") {
            // Default snooze window is 24h; client may override via
            // explicit snoozedUntil in the request body.
            const override = req.body?.snoozedUntil;
            signals[index].snoozedUntil =
              typeof override === "string" && override.length > 0
                ? override
                : new Date(Date.now() + DEFAULT_SNOOZE_MS).toISOString();
          } else if (state !== "snoozed") {
            // Transition out of snoozed clears the timestamp.
            delete signals[index].snoozedUntil;
          }
        }
        signals[index].lastUpdate = new Date().toLocaleString();
        if (typeof notedAt === "string" && notedAt.length > 0) {
          signals[index].notedAt = notedAt;
        }
        await redis.lset(key, index, JSON.stringify(signals[index]));

        // Brief cache invalidation — when a signal's
        // description / eta / status changes, the previously
        // cached morning/midday/evening prose is now stale and
        // could misquote the edited field. Clear the cache for
        // every household member so the next brief regenerates.
        if (hasDescription || hasEta || hasStatus) {
          try {
            await invalidateBriefCache(householdId);
          } catch (err) {
            console.warn("[cache] brief invalidation failed:", err?.message || err);
          }
        }

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
            try { await updateStreak(householdId); } catch (err) {
              console.warn("[streak] update failed:", err?.message || err);
            }
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

      // Same brief-cache invalidation as the :signals path.
      if (hasDescription || hasEta || hasStatus) {
        try { await invalidateBriefCache(householdId); }
        catch (err) { console.warn("[cache] deadlines brief invalidation failed:", err?.message); }
      }

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
          try { await updateStreak(householdId); } catch (err) {
            console.warn("[streak] update failed:", err?.message || err);
          }
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
