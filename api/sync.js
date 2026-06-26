import { Client } from "@upstash/qstash";
import { Redis } from "@upstash/redis";
import { runImport } from "./import.js";
import { runCalendarSync } from "./calendar.js";
import { runOuraSync } from "./oura-sync.js";
import { refreshLocalEventsCache } from "./events.js";
import { runOutlookImport } from "./outlook-import.js";
import { runImapImport } from "./imap-import.js";
import { runNextdoorScan } from "./nextdoor-scan.js";
import { synthesizeTripThreads } from "./trip-threads.js";
import { renewGmailWatchIfDue } from "./gmail-watch.js";

const qstash = process.env.QSTASH_TOKEN
  ? new Client({
      token: process.env.QSTASH_TOKEN,
      ...(process.env.QSTASH_URL ? { baseUrl: process.env.QSTASH_URL } : {}),
    })
  : null;
const WORKER_URL = "https://conductor-ivory.vercel.app/api/onboard-worker";

// Partial-onboard self-healing — fires once per day on the sync
// cron when household:{id}:vault / :crew / :horizon are still
// empty 24+ hours after the household was created. Each job is
// dispatched to /api/onboard-worker just like the original onboard
// fan-out so it inherits the 60s budget, qstash retries, and
// per-job status accounting.
//
// Skips households younger than 24h to avoid racing the first
// post-signup onboard. Each job runs at most once per sync because
// the sync cron itself is hourly.
async function selfHealHousehold(redis, householdId, members) {
  if (!members || members.length === 0) return;
  const primaryUser = members[0];

  const DAY_MS = 24 * 60 * 60 * 1000;
  // Households without a name key haven't been fully onboarded
  // either — skip self-heal so we don't kick off jobs against an
  // incomplete record.
  const nameRaw = await redis.get(`household:${householdId}:name`);
  if (!nameRaw) return;

  // Age check — use the earliest member's connectedAt as the
  // household creation proxy (mirrors the anniversary detector).
  let earliest = null;
  for (const uid of members) {
    try {
      const raw = await redis.get(`user:${uid}:profile`);
      const profile = typeof raw === "string" ? JSON.parse(raw) : raw;
      const ts = profile?.connectedAt;
      if (typeof ts === "number" && (earliest == null || ts < earliest)) {
        earliest = ts;
      }
    } catch { /* skip */ }
  }
  if (earliest == null) return;
  if (Date.now() - earliest < DAY_MS) return;

  async function dispatch(job) {
    if (qstash) {
      try {
        await qstash.publishJSON({
          url: WORKER_URL,
          body: { userId: primaryUser, householdId, job },
          retries: 1,
        });
        console.log(`[self-heal] enqueued ${job} for ${householdId}`);
        return;
      } catch (err) {
        console.warn(`[self-heal] qstash publish failed for ${job}:`, err?.message);
      }
    }
    // Fallback: direct fire-and-forget POST.
    fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: primaryUser, householdId, job }),
    }).catch(() => {});
    console.log(`[self-heal] direct-dispatched ${job} for ${householdId}`);
  }

  // Vault — list emptiness check.
  try {
    const vaultLen = await redis.llen(`household:${householdId}:vault`);
    if (!vaultLen || vaultLen === 0) await dispatch("vault");
  } catch (err) {
    console.warn(`[self-heal] vault probe failed:`, err?.message);
  }

  // Crew — JSON-string key; treat null / empty array as missing.
  try {
    const crewRaw = await redis.get(`household:${householdId}:crew`);
    const crew = (() => {
      if (!crewRaw) return [];
      try { return Array.isArray(crewRaw) ? crewRaw : JSON.parse(crewRaw); }
      catch { return []; }
    })();
    if (!Array.isArray(crew) || crew.length === 0) await dispatch("crew");
  } catch (err) {
    console.warn(`[self-heal] crew probe failed:`, err?.message);
  }

  // Horizon — only re-trigger if vault has items (horizon depends
  // on the vault sweep's output). Otherwise queue-ordering risks
  // running horizon against a still-empty vault.
  try {
    const horizonRaw = await redis.get(`household:${householdId}:horizon`);
    const vaultLen = await redis.llen(`household:${householdId}:vault`);
    if (!horizonRaw && vaultLen > 0) await dispatch("horizon");
  } catch (err) {
    console.warn(`[self-heal] horizon probe failed:`, err?.message);
  }
}

// Anticipated-signal generator. Reads
// household:{id}:senderPatterns (HASH, written by api/import.js
// when a recurring sender pattern is detected); for each pattern
// whose last signal is overdue by >20% of its interval, drops an
// "anticipated" signal into :signals so the brief can surface the
// missing recurring item softly. Idempotent — re-checks for existing
// anticipated entries before adding a new one.
//
// IMPORTANT: this used to read household:{id}:patterns, but that key
// is a LIST written by onboard-worker.js (observation patterns from
// the email/calendar sweep) — calling hgetall on it produced
// WRONGTYPE on every sync. The HASH lives on its own key now.
async function generateAnticipatedSignals(redis, householdId) {
  let patternsRaw;
  try {
    patternsRaw = await redis.hgetall(`household:${householdId}:senderPatterns`);
  } catch (err) {
    // Defensive: if a future migration leaves the key in an unexpected
    // type, swallow rather than crashing the entire sync sweep.
    console.warn(`[anticipated] senderPatterns read failed for ${householdId}:`, err?.message || err);
    return 0;
  }
  if (!patternsRaw || Object.keys(patternsRaw).length === 0) return 0;

  const signalsKey = `household:${householdId}:signals`;
  const rawSignals = await redis.lrange(signalsKey, 0, 199);
  const existingSignals = [];
  for (const r of rawSignals || []) {
    try { existingSignals.push(typeof r === "string" ? JSON.parse(r) : r); } catch { /* skip */ }
  }

  let created = 0;
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  for (const [patternKey, value] of Object.entries(patternsRaw)) {
    let pattern;
    try { pattern = typeof value === "string" ? JSON.parse(value) : value; } catch { continue; }
    if (!pattern || !pattern.sender || !pattern.type || !pattern.intervalDays) continue;
    const intervalMs = pattern.intervalDays * DAY_MS;
    const lastMs = pattern.lastSignalAt || 0;
    if (!lastMs) continue;
    const overdueBy = now - (lastMs + intervalMs);
    if (overdueBy < intervalMs * 0.2) continue;

    // Build the description first so the dedup below can key off it.
    const desc = pattern.description
      ? `Expected: ${pattern.description} from ${pattern.sender}`
      : `Expected: ${pattern.sender} (${pattern.type})`;

    // Dedup: skip if a non-resolved anticipated signal with this exact
    // description already exists in the pool.
    //
    // The previous guard compared `s.type === pattern.type`, but
    // anticipated signals are stored with type:"anticipated" — never the
    // pattern's real type — so the condition could NEVER be true. The
    // generator therefore re-created the same item on every sync run,
    // producing the 7+ "Expected: ... Bra from Amazon.com" duplicates.
    //
    // We match not-resolved (active/incoming/expired), not active-only,
    // deliberately: anticipated signals are always created with a past
    // ETA (expectedByDate = lastSignalAt + interval, emitted only once
    // overdue) and fall under the 24h legacy expiry window, so they flip
    // to "expired" within a day. An active-only check would miss the
    // freshly-expired copy and let duplicates pile right back up. An
    // expired copy still means "we already nudged this," so it blocks.
    const descKey = desc.toLowerCase().trim();
    const alreadyAnticipated = existingSignals.some((s) =>
      s.source === "anticipated" &&
      s.state !== "resolved" &&
      typeof s.description === "string" &&
      s.description.toLowerCase().trim() === descKey
    );
    if (alreadyAnticipated) continue;

    // Also skip if a real (non-anticipated) signal of this pattern's type
    // arrived from the same sender since the pattern was last updated.
    const recentReal = existingSignals.some((s) =>
      !s.anticipated && s.type === pattern.type &&
      typeof s.sender === "string" && s.sender.toLowerCase().trim() === pattern.senderKey &&
      (s.id || 0) > lastMs
    );
    if (recentReal) continue;
    const expectedByDate = new Date(lastMs + intervalMs).toISOString();
    const signal = {
      id: now + created,
      description: desc,
      type: "anticipated",
      sender: pattern.sender,
      eta: expectedByDate,
      expectedByDate,
      state: "incoming",
      source: "anticipated",
      confidence: 6,
      anticipated: true,
      lastUpdate: new Date(now).toLocaleString(),
    };
    await redis.lpush(signalsKey, JSON.stringify(signal));
    created++;
    console.log(
      `[anticipated] ${householdId}: ${pattern.sender} (${pattern.type}) — overdue by ${Math.round(overdueBy / DAY_MS)}d`
    );
  }
  return created;
}

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

async function scanHouseholdKeys() {
  const keys = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, {
      match: "user:*:household",
      count: 100,
    });
    cursor = next;
    if (batch && batch.length) keys.push(...batch);
  } while (cursor !== "0" && cursor !== 0);
  return keys;
}

// MM-DD anchor → days until its next occurrence (self-contained; tolerant of
// MM-DD, MM-DD-YYYY, and YYYY-MM-DD). Returns { days, date, year } or null.
function daysUntilAnchor(raw) {
  if (!raw || typeof raw !== "string") return null;
  let mm, dd, m;
  if ((m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/))) { mm = +m[2]; dd = +m[3]; }
  else if ((m = raw.match(/^(\d{1,2})-(\d{1,2})(?:-(\d{2,4}))?$/))) { mm = +m[1]; dd = +m[2]; }
  else return null;
  if (!(mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) return null;
  // "Today" is computed in the household's local zone (ET), NOT the server's
  // UTC — otherwise the exact 7/2-day milestone match drifts by a day near the
  // ET-evening / UTC-next-day boundary. Diff via Date.UTC so the day-count is
  // timezone-neutral once both anchors are ET calendar dates.
  const [tm, td, ty] = new Date()
    .toLocaleDateString("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
    .split("/")
    .map(Number);
  const todayUTC = Date.UTC(ty, tm - 1, td);
  let year = ty;
  let candUTC = Date.UTC(ty, mm - 1, dd);
  if (candUTC < todayUTC) { year = ty + 1; candUTC = Date.UTC(year, mm - 1, dd); }
  return { days: Math.round((candUTC - todayUTC) / (24 * 60 * 60 * 1000)), date: new Date(candUTC), year };
}

// Birthday / anniversary signals at exactly 7 and 2 days out. Stable, per-
// (person, occasion, year, milestone) id so the daily cron never duplicates.
// Covers crew members and household-member profiles.
async function createMilestoneSignals(redis, householdId) {
  const MILESTONES = [7, 2];
  const sigKey = `household:${householdId}:signals`;
  const rawSignals = await redis.lrange(sigKey, 0, -1).catch(() => []);
  const existingIds = new Set();
  for (const r of rawSignals || []) {
    try { const s = typeof r === "string" ? JSON.parse(r) : r; if (s?.id != null) existingIds.add(String(s.id)); } catch { /* skip */ }
  }

  const tuples = [];
  try {
    const rawCrew = await redis.get(`household:${householdId}:crew`);
    const crew = Array.isArray(rawCrew) ? rawCrew : (rawCrew ? JSON.parse(rawCrew) : []);
    for (const m of crew || []) {
      if (m?.birthday) tuples.push({ name: m.name || "Someone", occasion: "birthday", anchor: m.birthday });
      if (m?.anniversary) tuples.push({ name: m.name || "Someone", occasion: "anniversary", anchor: m.anniversary });
    }
  } catch { /* no crew */ }
  try {
    const members = await redis.smembers(`household:${householdId}:members`);
    for (const uid of members || []) {
      const raw = await redis.get(`user:${uid}:profile`);
      const p = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
      const first = (p?.name || "").split(/\s+/)[0] || null;
      if (first && p?.birthday) tuples.push({ name: first, occasion: "birthday", anchor: p.birthday });
      if (first && p?.anniversary) tuples.push({ name: first, occasion: "anniversary", anchor: p.anniversary });
    }
  } catch { /* no members */ }

  let created = 0;
  for (const t of tuples) {
    const info = daysUntilAnchor(t.anchor);
    if (!info || !MILESTONES.includes(info.days)) continue;
    const nameKey = t.name.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const id = `milestone_${nameKey}_${t.occasion}_${info.year}_${info.days}d`;
    if (existingIds.has(id)) continue; // already created — no duplicate
    const possessive = /s$/i.test(t.name) ? `${t.name}'` : `${t.name}'s`;
    const signal = {
      id,
      description: `${possessive} ${t.occasion} in ${info.days} days`,
      type: "milestone",
      eta: info.date.toISOString(),
      sender: "Conductor",
      status: null,
      state: "incoming",
      source: "milestone",
      occasion: t.occasion,
      emotionalValence: "joyful",
      emotionalIntensity: "medium",
      lastUpdate: new Date().toLocaleString(),
      createdAt: Date.now(),
    };
    await redis.lpush(sigKey, JSON.stringify(signal));
    existingIds.add(id);
    created++;
    console.log(`[milestone] ${householdId}: created "${signal.description}"`);
  }
  return created;
}

export default async function handler(req, res) {
  const errors = [];
  let signalsImported = 0;

  try {
    const keys = await scanHouseholdKeys();

    // Group members by householdId. Falls back to userId-as-household when the
    // stored value is empty, matching the convention used elsewhere in the API.
    const households = new Map();
    for (const key of keys) {
      const userId = key.slice("user:".length, -":household".length);
      let householdId;
      try {
        householdId = (await redis.get(key)) || userId;
      } catch (err) {
        errors.push({ stage: "resolve-household", userId, message: err.message });
        continue;
      }
      if (!households.has(householdId)) households.set(householdId, []);
      households.get(householdId).push(userId);
    }

    // Batch processing — 8 households in parallel per chunk, with a
    // 45s timeout race per household so a single hung Gmail call
    // doesn't stall the whole sweep. 2s settle between chunks to
    // avoid simultaneous Anthropic/Upstash burst-throttling.
    const BATCH_SIZE = 8;
    const BATCH_DELAY_MS = 2000;
    const PER_HOUSEHOLD_TIMEOUT_MS = 45000;

    async function processHousehold(householdId, members) {
      // Birthday/anniversary milestone signals first — it's fast and Redis-only,
      // so it must run BEFORE the slower Google-dependent stages that can exhaust
      // the per-household timeout (otherwise it never executes when a token is
      // dead and import/calendar retries burn the clock).
      try {
        await createMilestoneSignals(redis, householdId);
      } catch (err) {
        errors.push({ stage: "milestone-signals", householdId, message: err.message });
      }
      for (const userId of members) {
        try {
          const result = await runImport(userId);
          if (typeof result?.imported === "number") {
            signalsImported += result.imported;
          }
        } catch (err) {
          errors.push({ stage: "import", householdId, userId, message: err.message });
        }
        // Gmail watch renewal — watches expire after 7 days; renew at 6 so
        // real-time push never lapses. No-ops (returns "fresh") on most runs,
        // so this stays cheap on the hourly cron. Best-effort by design.
        try {
          await renewGmailWatchIfDue(userId);
        } catch (err) {
          errors.push({ stage: "gmail-watch", householdId, userId, message: err.message });
        }
      }
      // Refresh trip threads after the Gmail import pass so any signals
      // absorbed this cycle land in their configured/auto thread records
      // (and new auto-threads form). Best-effort — never blocks the sync.
      try {
        await synthesizeTripThreads(redis, householdId);
      } catch (err) {
        errors.push({ stage: "trip-threads", householdId, message: err.message });
      }
      // Outlook import per member who has tokens. Gmail failure
      // doesn't block this — they're independent driver paths.
      // Tokens-absent is a silent skip (this is the common case until
      // the user connects their Microsoft account).
      for (const userId of members) {
        try {
          const hasTokens = await redis.exists(`user:${userId}:outlookTokens`);
          if (!hasTokens) continue;
          const result = await runOutlookImport(userId);
          if (typeof result?.imported === "number") {
            signalsImported += result.imported;
          }
        } catch (err) {
          errors.push({ stage: "outlook", householdId, userId, message: err.message });
        }
      }
      // IMAP import per member who has an imapConfig. Catches iCloud,
      // Yahoo, and any user-configured custom IMAP host. Failure
      // scoped — bad IMAP creds shouldn't break Gmail/Outlook for
      // the same user.
      for (const userId of members) {
        try {
          const hasImap = await redis.exists(`user:${userId}:imapConfig`);
          if (!hasImap) continue;
          const result = await runImapImport(userId);
          if (typeof result?.imported === "number") {
            signalsImported += result.imported;
          }
        } catch (err) {
          errors.push({ stage: "imap", householdId, userId, message: err.message });
        }
      }
      // Nextdoor neighborhood scan per member who has connected.
      // Surfaces safety alerts as high-urgency signals + feeds
      // Commons + local-event surfaces. Tokens-absent silent skip.
      for (const userId of members) {
        try {
          const hasNextdoor = await redis.exists(`user:${userId}:nextdoorTokens`);
          if (!hasNextdoor) continue;
          await runNextdoorScan(userId);
        } catch (err) {
          errors.push({ stage: "nextdoor", householdId, userId, message: err.message });
        }
      }
      for (const userId of members) {
        try {
          await runCalendarSync(userId);
        } catch (err) {
          errors.push({ stage: "calendar", householdId, userId, message: err.message });
        }
      }
      for (const userId of members) {
        try {
          const hasTokens = await redis.exists(`user:${userId}:ouraTokens`);
          if (!hasTokens) continue;
          await runOuraSync(userId);
        } catch (err) {
          errors.push({ stage: "oura", householdId, userId, message: err.message });
        }
      }
      try {
        await generateAnticipatedSignals(redis, householdId);
      } catch (err) {
        errors.push({ stage: "anticipated", householdId, message: err.message });
      }
      // Eventbrite local-events cache refresh. Credential-gated; no-ops
      // when EVENTBRITE_API_KEY isn't set. Only attempts when the
      // household has a known centroid (location.lat/lon) — otherwise
      // there's nothing to anchor the radius search to.
      try {
        const rawLoc = await redis.get(`household:${householdId}:location`);
        const loc = (() => {
          if (!rawLoc) return null;
          try { return typeof rawLoc === "string" ? JSON.parse(rawLoc) : rawLoc; } catch { return null; }
        })();
        if (loc && typeof loc.lat === "number" && typeof loc.lon === "number") {
          await refreshLocalEventsCache(redis, householdId, loc.lat, loc.lon);
        }
      } catch (err) {
        errors.push({ stage: "eventbrite", householdId, message: err.message });
      }
      // NWS severe-weather alerts — auto-trigger Red Alert when the
      // active feed for this household's coords includes Severe or
      // Extreme certainty:Warning/Watch events and no Red Alert is
      // already active. Free, no API key required. Best-effort: any
      // hiccup falls through silently.
      try {
        const rawLoc = await redis.get(`household:${householdId}:location`);
        const loc = (() => {
          if (!rawLoc) return null;
          try { return typeof rawLoc === "string" ? JSON.parse(rawLoc) : rawLoc; } catch { return null; }
        })();
        if (loc && typeof loc.lat === "number" && typeof loc.lon === "number") {
          const existing = await redis.get(`household:${householdId}:activeAlert`).catch(() => null);
          if (!existing) {
            const resp = await fetch(
              `https://api.weather.gov/alerts/active?point=${loc.lat},${loc.lon}`,
              { headers: { "User-Agent": "Conductor (conductor-ivory.vercel.app)", Accept: "application/geo+json" } }
            );
            if (resp.ok) {
              const data = await resp.json();
              const severe = (data?.features || []).filter((f) => {
                const sev = f?.properties?.severity;
                const cert = f?.properties?.certainty;
                return ["Severe", "Extreme"].includes(sev) && ["Warning", "Watch"].includes(cert);
              });
              if (severe.length > 0) {
                const top = severe[0]?.properties;
                const headline = (top?.headline || top?.event || "Severe weather alert").slice(0, 400);
                const { postAlert } = await import("./alert.js");
                await postAlert({
                  householdId,
                  alertType: "WEATHER_EMERGENCY",
                  description: headline,
                  severity: "red",
                  source: "nws",
                });
                console.log(`[nws] red alert raised for ${householdId}: ${headline}`);
              }
            }
          }
        }
      } catch (err) {
        errors.push({ stage: "nws", householdId, message: err.message });
      }

      try {
        await selfHealHousehold(redis, householdId, members);
      } catch (err) {
        errors.push({ stage: "self-heal", householdId, message: err.message });
      }
      try {
        await redis.set(`household:${householdId}:lastSync`, Date.now());
      } catch (err) {
        errors.push({ stage: "stamp-lastSync", householdId, message: err.message });
      }
    }

    const householdEntries = Array.from(households.entries());
    const chunks = [];
    for (let i = 0; i < householdEntries.length; i += BATCH_SIZE) {
      chunks.push(householdEntries.slice(i, i + BATCH_SIZE));
    }

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      await Promise.all(
        chunk.map(([householdId, members]) =>
          Promise.race([
            processHousehold(householdId, members),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error(`per-household timeout after ${PER_HOUSEHOLD_TIMEOUT_MS}ms`)),
                PER_HOUSEHOLD_TIMEOUT_MS
              )
            ),
          ]).catch((err) => {
            errors.push({
              stage: "household-batch",
              householdId,
              message: err?.message || String(err),
            });
          })
        )
      );
      if (i < chunks.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    return res.status(200).json({
      "householdsSync'd": households.size,
      signalsImported,
      errors,
    });
  } catch (error) {
    console.error("Sync error:", error);
    return res.status(500).json({
      error: "Sync failed",
      message: error.message,
      "householdsSync'd": 0,
      signalsImported,
      errors,
    });
  }
}
