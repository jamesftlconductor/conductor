import { Client } from "@upstash/qstash";
import { Redis } from "@upstash/redis";
import { runImport } from "./import.js";
import { runCalendarSync } from "./calendar.js";
import { runOuraSync } from "./oura-sync.js";
import { refreshLocalEventsCache } from "./events.js";
import { runOutlookImport } from "./outlook-import.js";
import { runImapImport } from "./imap-import.js";
import { runNextdoorScan } from "./nextdoor-scan.js";

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

// Anticipated-signal generator. Reads household:{id}:patterns; for each
// pattern whose last signal is overdue by >20% of its interval, drops
// an "anticipated" signal into :signals so the brief can surface the
// missing recurring item softly. Idempotent — re-checks for existing
// anticipated entries before adding a new one.
async function generateAnticipatedSignals(redis, householdId) {
  const patternsRaw = await redis.hgetall(`household:${householdId}:patterns`);
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

    // Skip if there's already an anticipated signal for this pattern,
    // or a real signal arrived since the pattern was last updated.
    const alreadyAnticipated = existingSignals.some((s) =>
      s.anticipated === true && s.type === pattern.type &&
      typeof s.sender === "string" && s.sender.toLowerCase().trim() === pattern.senderKey
    );
    if (alreadyAnticipated) continue;
    const recentReal = existingSignals.some((s) =>
      !s.anticipated && s.type === pattern.type &&
      typeof s.sender === "string" && s.sender.toLowerCase().trim() === pattern.senderKey &&
      (s.id || 0) > lastMs
    );
    if (recentReal) continue;

    const desc = pattern.description
      ? `Expected: ${pattern.description} from ${pattern.sender}`
      : `Expected: ${pattern.sender} (${pattern.type})`;
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
      for (const userId of members) {
        try {
          const result = await runImport(userId);
          if (typeof result?.imported === "number") {
            signalsImported += result.imported;
          }
        } catch (err) {
          errors.push({ stage: "import", householdId, userId, message: err.message });
        }
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
