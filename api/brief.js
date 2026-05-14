import { Redis } from "@upstash/redis";
import { loadHouseholdCalendar } from "./calendar-loader.js";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// Fort Lauderdale for now; later we'll resolve per-household location.
const WEATHER_LAT = 26.1224;
const WEATHER_LON = -80.1373;
const WEATHER_TIMEZONE = "America/New_York";
const WEATHER_TIMEOUT_MS = 3000;

// ---------- helpers ----------

// Open-Meteo's WMO weather codes mapped to the small vocabulary that
// drives the conditional usage rules in baseRules. We deliberately
// don't surface every WMO subdivision — Claude only needs to know
// "is this rain, snow, storm, or normal" to decide whether weather is
// load-bearing for any signal.
function classifyWeather(code, tempF) {
  let condition;
  if (code <= 1) condition = "Clear";
  else if (code <= 3) condition = "Partly cloudy";
  else if (code >= 45 && code <= 48) condition = "Foggy";
  else if (code >= 51 && code <= 67) condition = "Rain";
  else if (code >= 71 && code <= 77) condition = "Snow";
  else if (code >= 80 && code <= 82) condition = "Showers";
  else if (code >= 95 && code <= 99) condition = "Thunderstorm";
  else condition = "Mixed";
  return `${tempF}°F, ${condition}`;
}

// Best-effort fetch of current weather. Returns null on any failure
// (network, timeout, malformed payload) so the brief still ships
// without weather context. 3s timeout keeps the overall brief
// latency bounded even when Open-Meteo is slow.
async function fetchWeather() {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), WEATHER_TIMEOUT_MS);
    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${WEATHER_LAT}&longitude=${WEATHER_LON}` +
      `&current=temperature_2m,precipitation,weathercode` +
      `&temperature_unit=fahrenheit` +
      `&timezone=${encodeURIComponent(WEATHER_TIMEZONE)}`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = await res.json();
    const current = data?.current;
    if (!current || typeof current.temperature_2m !== "number") return null;
    const tempF = Math.round(current.temperature_2m);
    const isRaining = (current.precipitation ?? 0) > 0;
    const weatherCode = current.weathercode ?? 0;
    return {
      tempF,
      isRaining,
      weatherCode,
      summary: classifyWeather(weatherCode, tempF),
    };
  } catch (err) {
    console.error("Weather fetch failed:", err?.message || err);
    return null;
  }
}

function parseDateLoose(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return isNaN(ms) ? null : new Date(ms);
}

function dayOffsetFromToday(date) {
  const a = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const now = new Date();
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((a.getTime() - t.getTime()) / DAY_MS);
}

function withinNextDays(date, days) {
  const ms = date.getTime() - Date.now();
  return ms <= days * DAY_MS && ms > -DAY_MS; // allow ~1 day overdue tolerance
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

function classifyUrgent(s) {
  if (s.priority === "urgent") return true;
  const eta = parseDateLoose(s.eta);
  if (!eta) return false;
  const offset = dayOffsetFromToday(eta);
  if (offset === 0) {
    if (s.type === "service" || s.type === "reservation") return true;
    if (s.status === "Out for Delivery") return true;
  }
  if (s.type === "deadline" && withinNextDays(eta, 3)) return true;
  return false;
}

function isInNearWindow(s) {
  if (s.status === "Delivered") return false;
  const eta = parseDateLoose(s.eta);
  if (!eta) return true; // no ETA + not delivered → near window
  return withinNextDays(eta, 14);
}

function isHomeRequirement(s) {
  if (s.type !== "service") return false;
  const eta = parseDateLoose(s.eta);
  if (!eta) return false;
  const offset = dayOffsetFromToday(eta);
  return offset === 0 || offset === 1;
}

// Coarse ring classification used by the briefedToday mute logic. Inner =
// urgent right now, middle = within next 14 days, outer = everything else
// (including signals with no ETA — they live on the outer ring conceptually
// because we have no signal that they're imminent).
function computeRing(s) {
  if (classifyUrgent(s)) return "inner";
  if (isInNearWindow(s)) return "middle";
  return "outer";
}

// Cross-signal conflict detection — runs after pool computation, before
// the steady-state Claude call. Surfaces situations where two signals
// can't both be honored without intervention. Output drives a dedicated
// CONFLICTS section in the prompt + special-cased rules in baseRules.
//
// We treat a calendar event as "work-blocked" when its classification
// includes any of the work-context keywords. The spec calls this the
// "workSummary pool", but no such Redis key exists — we derive it from
// the household calendar at detection time.
function detectConflicts({
  activeSignals,
  allDeadlines,
  calendarEvents,
  householdNameMap,
  requestingUserId,
}) {
  const conflicts = [];
  const memberIds = [
    requestingUserId,
    ...Array.from(householdNameMap?.keys() || []),
  ].filter(Boolean);
  // Without member ids we can't reason about who's blocked — skip the
  // member-availability checks entirely. Deadline urgency still runs.
  const events = Array.isArray(calendarEvents) ? calendarEvents : [];
  // The calendar classifier (in onboard-worker.js Job 2 and calendar.js
  // runCalendarSync) emits a structured `type` enum ("work"/"household"/
  // "personal"/"travel"/"childcare") and a `workConflictCheck` boolean
  // explicitly meaning "this blocks the person and could conflict with
  // household events". Prefer those structured fields over substring
  // search — they're authoritative. eventClassifiedAs is kept as a
  // fallback for events that slipped through the classifier as
  // type:"unknown" but still have a tell-tale title ("Team meeting").
  const blockingEvents = events.filter((e) =>
    e.workConflictCheck === true ||
    e.type === "work" ||
    eventClassifiedAs(e, ["work", "meeting", "call", "office"])
  );

  const memberWork = new Map(memberIds.map((id) => [id, []]));
  for (const e of blockingEvents) {
    const uid = e.userId;
    if (!uid || !memberWork.has(uid)) continue;
    memberWork.get(uid).push(e);
  }

  function memberBlockedInWindow(uid, startMs, endMs) {
    const list = memberWork.get(uid) || [];
    return list.some((e) => {
      const s = parseDateLoose(e.start)?.getTime();
      const eMs =
        parseDateLoose(e.end)?.getTime() || (s ? s + HOUR_MS : null);
      if (!s || !eMs) return false;
      return s <= endMs && eMs >= startMs;
    });
  }

  function startOfDayMs(date) {
    return new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate()
    ).getTime();
  }

  // 1. SERVICE — service signal today/tomorrow, every household member
  //    blocked by a work event in a ±2h window around the ETA. Coarse
  //    by design: most service appointments don't expose a duration
  //    field, so we use a fixed window rather than try to infer one.
  if (memberIds.length > 0) {
    for (const s of activeSignals) {
      if (s.type !== "service") continue;
      const eta = parseDateLoose(s.eta);
      if (!eta) continue;
      const offset = dayOffsetFromToday(eta);
      if (offset !== 0 && offset !== 1) continue;
      const winStart = eta.getTime() - 2 * HOUR_MS;
      const winEnd = eta.getTime() + 2 * HOUR_MS;
      const allBlocked = memberIds.every((uid) =>
        memberBlockedInWindow(uid, winStart, winEnd)
      );
      if (allBlocked) {
        conflicts.push({
          type: "service_conflict",
          signal: s,
          reason: "nobody available",
          severity: "high",
        });
      }
    }

    // 2. DELIVERY — Out for Delivery today, every member blocked at
    //    some point during the day (signature deliveries don't share
    //    arrival windows with us; coarse-day overlap is the best we
    //    can do).
    for (const s of activeSignals) {
      if (s.status !== "Out for Delivery") continue;
      const eta = parseDateLoose(s.eta);
      if (!eta) continue;
      if (dayOffsetFromToday(eta) !== 0) continue;
      const ds = startOfDayMs(eta);
      const de = ds + 24 * HOUR_MS - 1;
      const allBlocked = memberIds.every((uid) =>
        memberBlockedInWindow(uid, ds, de)
      );
      if (allBlocked) {
        conflicts.push({
          type: "delivery_conflict",
          signal: s,
          reason: "nobody home for signature",
          severity: "medium",
        });
      }
    }
  }

  // 3. TRAVEL — travel signal within 48h that shares its day with a
  //    service or signature-delivery signal. Doesn't depend on member
  //    availability since travel is presence-blocking on its own.
  for (const t of activeSignals) {
    if (t.type !== "travel") continue;
    const eta = parseDateLoose(t.eta);
    if (!eta) continue;
    const hoursOut = (eta.getTime() - Date.now()) / HOUR_MS;
    if (hoursOut < -1 || hoursOut > 48) continue;
    const ds = startOfDayMs(eta);
    const de = ds + 24 * HOUR_MS - 1;
    const conflicting = activeSignals.find((o) => {
      if (String(o.id) === String(t.id)) return false;
      const isPhysical = o.type === "service" || o.status === "Out for Delivery";
      if (!isPhysical) return false;
      const oe = parseDateLoose(o.eta);
      if (!oe) return false;
      const ot = oe.getTime();
      return ot >= ds && ot <= de;
    });
    if (conflicting) {
      conflicts.push({
        type: "travel_conflict",
        signal: t,
        conflictingSignal: conflicting,
        reason: "timing conflict",
        severity: "high",
      });
    }
  }

  // 4. DEADLINE — vault item with renewalDate within 7 days and not
  //    handled. Pure date-math; no member context required.
  for (const v of allDeadlines) {
    if (v.handled) continue; // upstream filter already drops these but be safe
    const eta = parseDateLoose(v.eta);
    if (!eta) continue;
    const days = (eta.getTime() - Date.now()) / DAY_MS;
    if (days < -1 || days > 7) continue;
    const daysLeft = Math.max(0, Math.round(days));
    conflicts.push({
      type: "deadline_urgent",
      item: v,
      daysLeft,
      reason: `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`,
      severity: "high",
    });
  }

  // High before medium so the prompt's "lead with most severe" rule
  // and the iteration order in the brief both prioritize correctly.
  const severityRank = { high: 0, medium: 1, low: 2 };
  conflicts.sort(
    (a, b) => (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9)
  );
  return conflicts;
}

// Returns Map<userId, firstName> for every household member except the
// requesting user (whose first name comes from the existing userName
// resolution path). Uses the same scan pattern as sync.js and notify.js so
// new members joining via /api/invite are automatically picked up.
async function buildHouseholdNameMap(redis, householdId, requestingUserId) {
  const map = new Map();
  let cursor = "0";
  const memberKeys = [];
  do {
    const [next, batch] = await redis.scan(cursor, {
      match: "user:*:household",
      count: 100,
    });
    cursor = next;
    if (batch?.length) memberKeys.push(...batch);
  } while (cursor !== "0" && cursor !== 0);

  for (const key of memberKeys) {
    const memberUserId = key.slice("user:".length, -":household".length);
    if (memberUserId === requestingUserId) continue;
    const memberHouseholdId = await redis.get(key);
    if (memberHouseholdId !== householdId) continue;
    const profileRaw = await redis.get(`user:${memberUserId}:profile`);
    const profile =
      typeof profileRaw === "string" ? JSON.parse(profileRaw) : profileRaw;
    const firstName = profile?.name?.split(" ")[0];
    if (firstName) map.set(memberUserId, firstName);
  }
  return map;
}

// Returns the bracket tag for a signal/event/deadline based on its userId
// field. The requesting user's own signals get YOURS; another household
// member's get their first name; missing or unknown userIds fall back to
// HOUSEHOLD so Claude can choose neutral framing. Single-member
// households collapse every tag to YOURS since there is no one else.
function ownershipTag(item, requestingUserId, nameMap, isSingleMember = false) {
  if (isSingleMember) return "YOURS";
  if (!item || !item.userId) return "HOUSEHOLD";
  if (item.userId === requestingUserId) return "YOURS";
  const firstName = nameMap.get(item.userId);
  if (firstName) return `${firstName.toUpperCase()}'S`;
  return "HOUSEHOLD";
}

function eventClassifiedAs(e, keywords) {
  const haystack = [
    e.category,
    Array.isArray(e.tags) ? e.tags.join(" ") : "",
    e.classification,
    e.title,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return keywords.some((k) => haystack.includes(k));
}

function isWithinNextHours(date, hours) {
  const ms = date.getTime() - Date.now();
  return ms >= -HOUR_MS && ms <= hours * HOUR_MS;
}

// Third Claude call after the brief itself is generated and segment-tagged.
// Produces a 4-sentence first-person explanation of what the model included,
// excluded, and is watching but didn't surface. Best-effort: any failure
// returns null and the brief still ships without a transparency entry.
async function generateTransparency(brief, pools) {
  if (!brief) return null;

  const briefList = (arr) => {
    if (!arr || arr.length === 0) return "(none)";
    return arr.map((s) => `- ${s.description || "Unknown"}`).join("\n");
  };
  const eventList = (arr) => {
    if (!arr || arr.length === 0) return "(none)";
    return arr.map((e) => `- ${e.title || "Untitled"}`).join("\n");
  };

  const prompt = `You just generated this brief: ${brief}

The signals you considered were:
Urgent: ${briefList(pools.urgent)}
Near window: ${briefList(pools.near)}
Health context: ${pools.healthContext ? JSON.stringify(pools.healthContext) : "(not connected)"}
Weather today: ${pools.weather || "(not available)"}
Childcare: ${eventList(pools.childcare)}
Home requirements: ${briefList(pools.homeRequirements)}
Horizon: ${pools.horizon ? `- ${pools.horizon.description || "Unknown"}` : "(none)"}
Carried forward: ${briefList(pools.carriedForward)}

Write a plain-language explanation of how you thought about today. Cover:
1. What you included and why (1-2 sentences)
2. What you excluded and why (1 sentence)
3. What you're watching that didn't make the brief (1 sentence)

Rules:
- Write in first person as Conductor — "I included..." "I left out..."
- Plain text only, no markdown
- Maximum 4 sentences total
- Honest and specific — name actual signals
- Calm, not defensive
- Never assert what the user said, noted, mentioned, told you, indicated, expressed, confirmed, asked, or wrote. Describe only the signals present in the pool and how you weighed them. If you want to convey a user state, frame it as your own inference: "I inferred X" or "this reads like X" — never "you noted X".
- Weather should appear in your reasoning ONLY if a weather condition actually changed which signals you included, excluded, or framed differently. "The clear weather made it a good weekend" is NOT a reason — that's rationalization, not influence. If you would have made the same inclusion decisions regardless of weather, do not mention weather in your reasoning at all. Be honest about what actually drove your choices.`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await response.json();
    const text = data?.content?.[0]?.text?.trim();
    return text || null;
  } catch (err) {
    console.error("Transparency generation failed:", err);
    return null;
  }
}

// Fourth Claude call alongside segment-tagging and transparency. Produces
// "The Read" — 1-3 additional sentences of lower-urgency context that
// didn't make the main brief but are worth knowing this week. Surfaced
// on Ground via a collapsible section below the brief. Best-effort: any
// failure returns null and the brief still ships without it. Claude
// returns the literal string "NOTHING" when there's nothing additional
// worth saying — also mapped to null.
async function generateTheRead(brief, pools) {
  if (!brief) return null;

  const briefList = (arr) => {
    if (!arr || arr.length === 0) return "(none)";
    return arr.map((s) => `- ${s.description || "Unknown"}`).join("\n");
  };
  const eventList = (arr) => {
    if (!arr || arr.length === 0) return "(none)";
    return arr.map((e) => `- ${e.title || "Untitled"}`).join("\n");
  };

  const prompt = `You just wrote this brief: ${brief}

The signal pool was:
Urgent: ${briefList(pools.urgent)}
Near window: ${briefList(pools.near)}
Health context: ${pools.healthContext ? JSON.stringify(pools.healthContext) : "(not connected)"}
Weather today: ${pools.weather || "(not available)"}
Childcare: ${eventList(pools.childcare)}
Home requirements: ${briefList(pools.homeRequirements)}
Horizon: ${pools.horizon ? `- ${pools.horizon.description || "Unknown"}` : "(none)"}
Carried forward: ${briefList(pools.carriedForward)}

Always provide 1-2 sentences. If the brief already covered the most pressing items, write about what's quietly in the background — signals in motion that weren't urgent enough to lead with, things Conductor is watching, or forward-looking awareness for the week ahead. Never repeat anything specific from the brief. Never introduce new urgency. This is background awareness, not action items. Plain text only.`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await response.json();
    const text = data?.content?.[0]?.text?.trim();
    // No more NOTHING escape clause — the prompt now mandates 1-2
    // sentences of background awareness regardless. Only an empty
    // response (rare, indicates API failure mid-stream) returns null.
    return text || null;
  } catch (err) {
    console.error("The Read generation failed:", err);
    return null;
  }
}

async function tagBriefSegments(brief, signals) {
  const fallback = [{ type: "text", content: brief || "" }];
  if (!brief || !signals || signals.length === 0) return fallback;

  const signalList = signals
    .map((s) => `- id: ${s.id} | type: ${s.type || "unknown"} | description: ${s.description || "Unknown"}`)
    .join("\n");

  // Build the set of legal signalIds up front so the post-parse pass
  // can coerce any hallucinated/borrowed id back to a text segment.
  // Crew events, calendar appointments, and other pool items that
  // surface in the brief without being in this signal list would
  // otherwise pick up an arbitrary id from the pool.
  const validIds = new Set(signals.map((s) => String(s.id)));

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1500,
        messages: [{
          role: "user",
          content: `Given this brief text and these signals, return a JSON array of segments. Each segment is either:
- { type: 'text', content: '...' } for plain text
- { type: 'signal', content: '...', signalId: '...', signalType: '...' } for phrases that refer to a specific signal

signalType MUST be exactly one of: package, delivery, food, grocery, service, reservation, appointment, travel, deadline, unknown. Pick the closest match for the signal's nature. Use "unknown" if no value fits — never invent a different label.

CRITICAL: signalId MUST be copied verbatim from the Signals list below — never invent, never reuse one signal's id for an unrelated phrase. If a phrase in the brief refers to something NOT in the Signals list (a calendar event, a crew member's activity, a weather note, a health metric), it MUST be a 'text' segment. When in doubt, prefer 'text'.

Split the brief exactly — every character must appear in exactly one segment. Signal phrases should be the natural language reference to that signal as it appears in the brief (e.g. 'hair styling items' not the full description). Return only the JSON array, nothing else.

Brief:
${brief}

Signals:
${signalList}`,
        }],
      }),
    });

    const data = await response.json();
    const text = (data && data.content && data.content[0] && data.content[0].text) || "";
    const cleaned = text.trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed) || parsed.length === 0) return fallback;

    const rejoined = parsed
      .map((seg) => (seg && typeof seg.content === "string" ? seg.content : ""))
      .join("");
    if (rejoined !== brief && rejoined.trim() !== brief.trim()) return fallback;

    // Validation pass: any signal segment whose signalId isn't in the
    // input pool gets demoted to a text segment. Belt-and-braces on top
    // of the prompt — the prompt instruction is the first line of
    // defense, this guarantees correctness even when Claude drifts.
    let coercedCount = 0;
    const validated = parsed.map((seg) => {
      if (
        seg &&
        seg.type === "signal" &&
        (seg.signalId == null || !validIds.has(String(seg.signalId)))
      ) {
        coercedCount++;
        return { type: "text", content: seg.content };
      }
      return seg;
    });
    if (coercedCount > 0) {
      console.log(`[brief] segmenter coerced ${coercedCount} segment(s) with invalid signalId to text`);
    }

    return validated;
  } catch (err) {
    console.error("Segment tagging failed:", err);
    return fallback;
  }
}

// ---------- handler ----------

// Side-channel: returns the most recent stored Takeoff and Clearance briefs.
// Folded into brief.js to avoid a new function file. Both keys carry a 48h
// TTL set on every brief generation; the response also returns yesterday's
// calendar date so the modal can header it appropriately.
async function handleYesterday(req, res) {
  const { userId } = req.query;
  let householdId = "RangerOaks925";
  if (userId) {
    const hid = await redis.get(`user:${userId}:household`);
    if (hid) householdId = hid;
  }
  const [takeoff, clearance] = await Promise.all([
    redis.get(`household:${householdId}:yesterdayTakeoff`),
    redis.get(`household:${householdId}:yesterdayClearance`),
  ]);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const date = yesterday.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  return res.status(200).json({
    household: householdId,
    takeoff: typeof takeoff === "string" ? takeoff : null,
    clearance: typeof clearance === "string" ? clearance : null,
    date,
  });
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (req.query?.type === "yesterday") {
    return handleYesterday(req, res);
  }

  const { userId } = req.query;

  try {
    const today = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });

    let householdId = "RangerOaks925";
    if (userId) {
      const hid = await redis.get(`user:${userId}:household`);
      if (hid) householdId = hid;
    }

    let userName = "there";
    if (userId) {
      const profile = safeJson(await redis.get(`user:${userId}:profile`));
      if (profile && profile.name) userName = profile.name.split(" ")[0];
    }

    // Pull all sources in parallel
    const [
      rawSignals,
      rawCalendar,
      rawHealth,
      rawHorizon,
      rawDeadlines,
      rawBriefed,
      rawPreferences,
      firstRunFlag,
      rawBriefedToday,
      rawBriefedThisWeek,
      rawClearanceBriefed,
      rawCarriedForward,
      householdNameMap,
      rawFeedbackStats,
      fetchedWeather,
      rawCrew,
      rawMembers,
    ] = await Promise.all([
      redis.lrange(`household:${householdId}:signals`, 0, -1),
      // Multi-driver: merges per-user calendar slices, falls back to
      // the legacy single key for households that haven't synced yet
      // since the rollout. Returns a parsed array (not a JSON string),
      // but downstream safeJson on an array is a no-op so the existing
      // shape handling continues to work.
      loadHouseholdCalendar(redis, householdId),
      userId ? redis.get(`user:${userId}:health`) : Promise.resolve(null),
      redis.get(`household:${householdId}:horizon`),
      redis.lrange(`household:${householdId}:vault`, 0, -1),
      redis.lrange(`household:${householdId}:briefed`, 0, -1),
      userId ? redis.get(`user:${userId}:preferences`) : Promise.resolve(null),
      redis.get(`household:${householdId}:firstRun`),
      redis.hgetall(`household:${householdId}:briefedToday`),
      redis.smembers(`household:${householdId}:briefedThisWeek`),
      redis.smembers(`household:${householdId}:clearanceBriefed`),
      redis.smembers(`household:${householdId}:carriedForward`),
      buildHouseholdNameMap(redis, householdId, userId),
      redis.hgetall(`household:${householdId}:feedbackStats`),
      // Best-effort. Returns null on any failure so the brief still
      // ships without weather context. Hardcoded to Fort Lauderdale
      // for now; will resolve per-household location later.
      fetchWeather(),
      // Crew layer (children + pets). Single JSON-string key written
      // by the onboard worker's Job 4. Filter for today/tomorrow
      // events happens after parse, downstream.
      redis.get(`household:${householdId}:crew`),
      // Single-member households get a stripped-down ownership model:
      // all signals tag as YOURS and the prompt strips the multi-owner
      // narration rules. Avoids stilted "the household" framing when
      // there is only one person to address.
      redis.smembers(`household:${householdId}:members`),
    ]);
    const isSingleMember = (rawMembers || []).length <= 1;

    // Test override: ?testWeatherCode=N&testWeatherTemp=N replaces the
    // fetched weather with a synthetic value. Used to verify weather
    // rule triggers (rain + outdoor service, heat + HVAC, etc.) without
    // waiting for actual weather conditions. Both params required to
    // activate — has no effect on normal traffic.
    let weather = fetchedWeather;
    {
      const tCode = req.query?.testWeatherCode;
      const tTemp = req.query?.testWeatherTemp;
      if (tCode != null && tTemp != null) {
        const code = parseInt(tCode, 10);
        const tempF = parseInt(tTemp, 10);
        if (!isNaN(code) && !isNaN(tempF)) {
          weather = {
            tempF,
            weatherCode: code,
            isRaining: code >= 51 && code <= 99,
            summary: classifyWeather(code, tempF),
          };
        }
      }
    }

    const allSignals = (rawSignals || []).map(safeJson).filter(Boolean);

    // Carry-forward marking — happens before activeSignals is derived so the
    // flag is visible to downstream pools and the prompt. A signal that landed
    // in last night's clearanceBriefed (LAST CHANCE) and is still active this
    // morning gets carriedForward stamped on its record + an entry in the
    // carriedForward set so notify.js can detect "still open" at push time.
    const clearanceBriefedIds = new Set((rawClearanceBriefed || []).map(String));
    const carriedForwardKey = `household:${householdId}:carriedForward`;
    const carriedForwardIdsToAdd = [];
    if (clearanceBriefedIds.size > 0) {
      const signalsListKey = `household:${householdId}:signals`;
      for (let i = 0; i < allSignals.length; i++) {
        const s = allSignals[i];
        if (!s) continue;
        if (!clearanceBriefedIds.has(String(s.id))) continue;
        const stillActive = !s.state || s.state === "incoming" || s.state === "active";
        if (!stillActive) continue;
        if (s.carriedForward === true) continue; // already stamped on a prior run
        s.carriedForward = true;
        s.carriedForwardAt = Date.now();
        await redis.lset(signalsListKey, i, JSON.stringify(s));
        carriedForwardIdsToAdd.push(String(s.id));
      }
      if (carriedForwardIdsToAdd.length > 0) {
        await redis.sadd(carriedForwardKey, ...carriedForwardIdsToAdd);
        await redis.expire(carriedForwardKey, 48 * 60 * 60);
      }
    }

    const activeSignals = allSignals.filter(
      (s) => !s.state || s.state === "incoming" || s.state === "active"
    );

    const calendarEvents = safeJson(rawCalendar) || [];
    const healthContext = safeJson(rawHealth);
    const preferences = safeJson(rawPreferences) || { flaggedCategories: [] };
    if (!Array.isArray(preferences.flaggedCategories)) preferences.flaggedCategories = [];
    const briefedIds = new Set((rawBriefed || []).map((s) => String(s)));

    // Carry-forward pool — signals flagged on this run plus pre-existing ones
    // from the 48h set, intersected with still-active records. Drives both the
    // prompt section and (separately) the morning push suffix.
    const carriedForwardIds = new Set([
      ...(rawCarriedForward || []).map(String),
      ...carriedForwardIdsToAdd,
    ]);
    const carriedForwardSignals = activeSignals.filter((s) =>
      carriedForwardIds.has(String(s.id))
    );

    // Background-mute state — what was already narrated in the last 20h, and
    // what's been acknowledged this week. Both keys carry their own TTLs so
    // we don't have to prune here.
    const briefedTodayMap = (rawBriefedToday && typeof rawBriefedToday === "object")
      ? rawBriefedToday
      : {};
    const briefedThisWeek = new Set((rawBriefedThisWeek || []).map(String));

    // Returns the snapshot stored at the last brief, or null if this signal
    // wasn't in the previous run.
    function previousSnapshot(s) {
      const raw = briefedTodayMap[String(s.id)];
      if (raw == null) return null;
      if (typeof raw === "string") {
        try { return JSON.parse(raw); } catch { return null; }
      }
      return raw;
    }

    // True when status, state, and ring all match the prior brief — signal
    // hasn't moved meaningfully, so don't re-narrate. Urgent signals bypass
    // this check explicitly at the call site.
    function isBackgroundFiltered(s) {
      const prev = previousSnapshot(s);
      if (!prev) return false;
      const sameStatus = (prev.status || "") === (s.status || "");
      const sameState = (prev.state || "") === (s.state || "");
      const sameRing = (prev.ring || "") === computeRing(s);
      return sameStatus && sameState && sameRing;
    }

    // URGENT — never background-filtered. The user's instruction is explicit:
    // urgent always surfaces, even if the same signal landed in the last brief.
    const urgentSignals = activeSignals.filter(classifyUrgent);
    const urgentIds = new Set(urgentSignals.map((s) => String(s.id)));

    // NEAR WINDOW (excluding urgent) — background-filter applies. A near-window
    // signal that's already been narrated and hasn't shifted ring/status/state
    // moves to the silent background pool (still on the Hover radar, just not
    // narrated again until something changes).
    const nearSignals = activeSignals
      .filter((s) => !urgentIds.has(String(s.id)))
      .filter(isInNearWindow)
      .filter((s) => !isBackgroundFiltered(s));

    // DEADLINES — pulled from :vault (the new dedicated deadline storage).
    // Vault items use renewalDate; adapt to the eta-based shape the rest of
    // the file already expects, and stamp _isDeadline + type so the prompt
    // formatter renders them correctly. Pool boundaries per the vault spec:
    //   <14 days       → urgent
    //   14-60 days     → near window
    //   60-90 days     → horizon candidate (handled lower down)
    // Items past, beyond 90 days, or marked handled are dropped here.
    const allDeadlines = (rawDeadlines || [])
      .map(safeJson)
      .filter(Boolean)
      .filter((v) => !v.handled)
      .map((v) => ({
        ...v,
        eta: v.renewalDate || v.eta,
        _isDeadline: true,
        type: "deadline",
      }));
    const existingSignalDescs = new Set(
      activeSignals
        .map((s) => (s.description || "").toLowerCase().trim())
        .filter(Boolean)
    );

    function isSimilarToExistingSignal(desc) {
      if (!desc) return false;
      if (existingSignalDescs.has(desc)) return true;
      // substring overlap for "close match" — only if both strings are
      // long enough to make accidental overlap unlikely.
      for (const sd of existingSignalDescs) {
        if (sd.length >= 6 && desc.length >= 6 && (sd.includes(desc) || desc.includes(sd))) {
          return true;
        }
      }
      return false;
    }

    const urgentDeadlines = [];
    const nearDeadlines = [];
    for (const d of allDeadlines) {
      const eta = parseDateLoose(d.eta);
      if (!eta) continue;
      const desc = (d.description || "").toLowerCase().trim();
      if (isSimilarToExistingSignal(desc)) continue;
      const days = (eta.getTime() - Date.now()) / DAY_MS;
      if (days >= -1 && days < 14) urgentDeadlines.push(d);
      else if (days >= 14 && days <= 60) {
        // Near-window vault items get the background-filter treatment too —
        // same "don't repeat last brief" rule applies.
        if (!isBackgroundFiltered(d)) nearDeadlines.push(d);
      }
      // 60-90 days reserved for horizon; handled below.
    }

    // Combined pools used in the prompt assembly section below.
    const urgentForPrompt = [...urgentSignals, ...urgentDeadlines];
    const nearForPrompt = [...nearSignals, ...nearDeadlines];

    // CHILDCARE — calendar events classified as childcare/kids/school within next 48h
    const childcareEvents = (Array.isArray(calendarEvents) ? calendarEvents : [])
      .filter((e) => eventClassifiedAs(e, ["childcare", "kids", "school"]))
      .filter((e) => {
        const start = parseDateLoose(e.start);
        return start && isWithinNextHours(start, 48);
      });

    // HOME REQUIREMENTS — service signals today or tomorrow. Same mute rule:
    // if we already flagged "Plumber tomorrow at 9" yesterday and nothing
    // changed, don't say it again this morning.
    const homeRequirements = activeSignals
      .filter(isHomeRequirement)
      .filter((s) => !isBackgroundFiltered(s));

    // CREW — children + pets layer. Read the JSON-string household:{id}:crew
    // written by the onboard worker, then filter for upcomingEvents falling
    // today or tomorrow. The prompt rule below tells Claude to mention these
    // ONLY when something requires the household to act or be present —
    // routine recurring activities don't make the brief.
    const crewMembers = (() => {
      if (!rawCrew) return [];
      try {
        const parsed = typeof rawCrew === "string" ? JSON.parse(rawCrew) : rawCrew;
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    })();
    const crewToday = [];
    for (const m of crewMembers) {
      const relevantEvents = (m.upcomingEvents || []).filter((ev) => {
        const ms = parseDateLoose(ev.date)?.getTime();
        if (!ms) return false;
        const offset = dayOffsetFromToday(new Date(ms));
        return offset === 0 || offset === 1;
      });
      if (relevantEvents.length > 0) {
        crewToday.push({ ...m, _events: relevantEvents });
      }
    }
    function formatCrewLine(m) {
      const label = m.memberType === "pet"
        ? `${m.name || "pet"}${m.type ? ` (${m.type})` : ""}`
        : `${m.name || "child"}${m.age ? `, age ${m.age}` : ""}`;
      const evs = (m._events || []).map((e) => {
        const friendly = friendlyDate(e.date);
        return `${e.description}${friendly ? ` on ${friendly}` : ""}`;
      }).join("; ");
      return `- [${m.memberType.toUpperCase()}] ${label}: ${evs}`;
    }

    // FLAGGED CATEGORIES — match against nearSignals + calendar events.
    // nearSignals is already background-filtered above, so flagged-category
    // matches inherit the mute behavior automatically.
    const flaggedSignals = {};
    for (const cat of preferences.flaggedCategories) {
      if (!cat || typeof cat !== "string") continue;
      const matchingSignals = nearSignals.filter((s) => s.type === cat);
      const matchingEvents = (Array.isArray(calendarEvents) ? calendarEvents : []).filter((e) =>
        eventClassifiedAs(e, [cat.toLowerCase()])
      );
      if (matchingSignals.length > 0 || matchingEvents.length > 0) {
        flaggedSignals[cat] = {
          signals: matchingSignals.map((s) => ({
            id: s.id,
            description: s.description,
            eta: s.eta,
            status: s.status,
            owner: ownershipTag(s, userId, householdNameMap, isSingleMember),
          })),
          events: matchingEvents.map((e) => ({
            title: e.title,
            start: e.start,
            owner: ownershipTag(e, userId, householdNameMap, isSingleMember),
          })),
        };
      }
    }

    // HORIZON
    let horizonSignal = null;
    let storedHorizon = safeJson(rawHorizon);
    const horizonFresh =
      storedHorizon &&
      typeof storedHorizon.timestamp === "number" &&
      Date.now() - storedHorizon.timestamp < 7 * DAY_MS;

    if (horizonFresh) {
      horizonSignal = storedHorizon.signal;
    } else {
      // Reuse the vault-adapted allDeadlines list rather than re-parsing
      // rawDeadlines. Boundary moves to 60-90 days under the new partition
      // (urgent < 14, near 14-60, horizon 60-90).
      const candidates = allDeadlines.filter((d) => {
        if (briefedIds.has(String(d.id))) return false;
        const eta = parseDateLoose(d.eta);
        if (!eta) return false;
        const offsetDays = (eta.getTime() - Date.now()) / DAY_MS;
        return offsetDays >= 60 && offsetDays <= 90;
      });
      if (candidates.length > 0) {
        // Most surprising — prefer the closest to the 60-day edge that hasn't been briefed.
        candidates.sort(
          (a, b) => parseDateLoose(a.eta).getTime() - parseDateLoose(b.eta).getTime()
        );
        horizonSignal = candidates[0];
        await redis.set(
          `household:${householdId}:horizon`,
          JSON.stringify({ signal: horizonSignal, timestamp: Date.now() })
        );
        await redis.lpush(`household:${householdId}:briefed`, String(horizonSignal.id));
      }
    }

    // HORIZON AWARENESS — outer-ring signals (ETA > 14 days) that haven't
    // been acknowledged this week. Broader than HORIZON SIGNAL: any active
    // signal qualifies, not just deadlines. Picks the closest-ETA so the
    // weekly nod lands on the most imminent of the far-out things. We mark
    // the picked signal in briefedThisWeek after the response is generated.
    let horizonAwarenessSignal = null;
    {
      const candidates = activeSignals.filter((s) => {
        if (s.status === "Delivered") return false;
        if (briefedThisWeek.has(String(s.id))) return false;
        const eta = parseDateLoose(s.eta);
        if (!eta) return false;
        return dayOffsetFromToday(eta) > 14;
      });
      candidates.sort(
        (a, b) => parseDateLoose(a.eta).getTime() - parseDateLoose(b.eta).getTime()
      );
      horizonAwarenessSignal = candidates[0] || null;
    }

    const isFirstRun =
      firstRunFlag === true || firstRunFlag === "true" || firstRunFlag === 1 || firstRunFlag === "1";

    // ---------- prompt assembly ----------

    // Resolve raw timestamps server-side so Claude never has to compute day-of-week
    // or date arithmetic. The model just lifts the friendly string into the prose.
    const friendlyDate = (value) => {
      const d = parseDateLoose(value);
      if (!d) return null;
      return d.toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      });
    };
    const friendlyDateTime = (value) => {
      const d = parseDateLoose(value);
      if (!d) return null;
      return d.toLocaleString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    };

    const daysFromTodayPhrase = (value) => {
      const d = parseDateLoose(value);
      if (!d) return null;
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const target = new Date(d);
      target.setHours(0, 0, 0, 0);
      const n = Math.round((target.getTime() - startOfToday.getTime()) / DAY_MS);
      if (n === 0) return "today";
      if (n === 1) return "tomorrow";
      if (n > 0) return `in ${n} days`;
      // Past dates: surface explicitly so Claude doesn't frame them as
      // upcoming. -1 reads naturally as "yesterday" rather than
      // "already passed 1 day ago".
      if (n === -1) return "yesterday";
      return `already passed ${-n} days ago`;
    };

    const etaWithFriendly = (raw) => {
      const friendly = friendlyDate(raw);
      if (!raw) return "Unknown";
      if (!friendly) return raw;
      const phrase = daysFromTodayPhrase(raw);
      return phrase ? `${friendly} (${phrase}) (raw: ${raw})` : `${friendly} (raw: ${raw})`;
    };

    const formatSignal = (s) => {
      const owner = `[${ownershipTag(s, userId, householdNameMap, isSingleMember)}]`;
      if (s._isDeadline) {
        return `- ${owner} [DEADLINE] ${s.description || "Unknown"} | Due: ${etaWithFriendly(s.eta)} | Category: ${s.category || "uncategorized"}`;
      }
      return `- ${owner} ${s.description || "Unknown"} | ${s.status || "Unknown"} | ETA: ${etaWithFriendly(s.eta)} | Type: ${s.type || "unknown"}`;
    };
    const formatEvent = (e) => {
      const owner = `[${ownershipTag(e, userId, householdNameMap, isSingleMember)}]`;
      const friendly = friendlyDateTime(e.start);
      const when = friendly || (e.start ? `raw: ${e.start}` : "Unknown");
      return `- ${owner} ${e.title || "Untitled"} | ${when}`;
    };

    // ---------- first-run branch ----------
    // The first brief Conductor ever writes for a household runs on a
    // deliberately starved pipeline: skip the layered context, take at most
    // two strict-filtered signals, fall back through calendar → vault →
    // hardcoded copy. The goal is a calm, welcoming first impression that
    // doesn't try to dazzle with an unfiltered firehose. Whatever path we
    // take, firstRun is flipped to "false" so tomorrow uses the normal
    // pipeline.
    if (isFirstRun) {
      // Strict signal filter: drop type:unknown and signals with neither
      // status nor ETA (no information density at all). Sort by info-density
      // score (eta + sender + description present), break ties by ETA
      // proximity. Keep at most two.
      const firstRunCandidates = activeSignals.filter((s) => {
        if (s.type === "unknown") return false;
        const statusUnknown = !s.status || s.status === "Unknown";
        const etaMissing = s.eta == null || s.eta === "";
        if (statusUnknown && etaMissing) return false;
        return true;
      });

      const infoDensity = (s) =>
        (s.eta ? 1 : 0) + (s.sender ? 1 : 0) + (s.description ? 1 : 0);

      firstRunCandidates.sort((a, b) => {
        const d = infoDensity(b) - infoDensity(a);
        if (d !== 0) return d;
        const ea = parseDateLoose(a.eta);
        const eb = parseDateLoose(b.eta);
        if (ea && eb) return ea.getTime() - eb.getTime();
        if (ea) return -1;
        if (eb) return 1;
        return 0;
      });

      const strictPool = firstRunCandidates.slice(0, 2);

      // Calendar fallback — only consulted when strictPool is empty.
      // Window: next 30 days, with a one-day past-tolerance for events
      // that just rolled over.
      const calendarPool = strictPool.length > 0
        ? []
        : (Array.isArray(calendarEvents) ? calendarEvents : [])
            .filter((e) => {
              const start = parseDateLoose(e.start);
              if (!start) return false;
              const offsetDays = (start.getTime() - Date.now()) / DAY_MS;
              return offsetDays >= -1 && offsetDays <= 30;
            })
            .sort(
              (a, b) =>
                parseDateLoose(a.start).getTime() - parseDateLoose(b.start).getTime()
            )
            .slice(0, 2);

      // Vault fallback — only when both prior pools are empty. One item
      // max; pick the soonest non-handled future renewal.
      const vaultPool =
        strictPool.length > 0 || calendarPool.length > 0
          ? []
          : allDeadlines
              .filter((v) => {
                const eta = parseDateLoose(v.eta);
                return eta && eta.getTime() > Date.now() - DAY_MS;
              })
              .sort(
                (a, b) =>
                  parseDateLoose(a.eta).getTime() - parseDateLoose(b.eta).getTime()
              )
              .slice(0, 1);

      const noSignals =
        strictPool.length === 0 && calendarPool.length === 0 && vaultPool.length === 0;

      const noSignalsCopy =
        "Nothing pressing today — Conductor is getting acquainted with your household and will have more to say tomorrow morning. Enjoy the open day. Conductor is just getting started — today is yours.";

      let firstRunBrief;
      if (noSignals) {
        firstRunBrief = noSignalsCopy;
      } else {
        let contextBlock;
        if (strictPool.length > 0) {
          contextBlock = `SIGNALS:\n${strictPool.map(formatSignal).join("\n")}`;
        } else if (calendarPool.length > 0) {
          contextBlock = `UPCOMING EVENTS:\n${calendarPool.map(formatEvent).join("\n")}`;
        } else {
          contextBlock = `DEADLINE:\n${vaultPool.map(formatSignal).join("\n")}`;
        }

        const firstRunRules = `FIRST-RUN RULES:
- This is the household's first brief. Be welcoming but not effusive.
- Maximum 2-3 sentences total.
- End with EXACTLY this sentence: "Conductor is just getting started — today is yours."
- Do not mention that this is the first brief.
- Tone: warm but not effusive. Give the user permission to relax. Hint at depth without explaining it. Feel like a trusted presence on day one.
- Plain text only, no markdown.
- Do not begin with date or header.
- Personalize to ${userName}.
${isSingleMember
  ? `- This is a single-person household. Always use "you" and "your". Never refer to any other household member by name. All signals belong to you. Never include the bracket tag in the brief.`
  : `- Ownership tags: every item is prefixed [YOURS], [NAME'S], or [HOUSEHOLD]. Use "you" for [YOURS], the named person for [NAME'S], household framing for [HOUSEHOLD]. NEVER include the bracket tags in the brief.`}
- When referring to a future date, lift the day-and-date verbatim from the friendly string already provided in the ETA field. NEVER compute or infer a date.
- If an item's ETA is "Unknown" or missing, do NOT invent or guess a date — even for holidays mentioned in the description.`;

        const firstRunUserPrompt = `Today is ${today}.\n\n${contextBlock}\n\n${firstRunRules}`;
        const firstRunSystemPrompt = `You are Conductor, a household intelligence layer. You write calm, trusted, personal morning briefs for ${userName}. Your voice is like a thought the reader was already having — never assistant-like, never listy, always prose.`;

        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": process.env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 300,
            system: firstRunSystemPrompt,
            messages: [{ role: "user", content: firstRunUserPrompt }],
          }),
        });
        const data = await response.json();
        firstRunBrief = (data && data.content && data.content[0] && data.content[0].text) || "";
        // Defensive: if the model returns empty text, ship the hardcoded
        // copy so the user's first impression isn't a blank screen.
        if (!firstRunBrief) firstRunBrief = noSignalsCopy;
      }

      // Persist the brief and flip the flag. Even on noSignals we flip —
      // otherwise a household with no early signals stays stuck on the
      // welcome copy forever instead of moving onto the normal pipeline.
      if (firstRunBrief) {
        await redis.set(`household:${householdId}:yesterdayTakeoff`, firstRunBrief, {
          ex: 48 * 60 * 60,
        });
      }
      await redis.set(`household:${householdId}:firstRun`, "false");

      // Segment tagging best-effort. Calendar events aren't taggable
      // signals, so when the brief came from the calendar fallback we
      // ship a single text segment.
      const taggableSignals =
        strictPool.length > 0 ? strictPool : vaultPool.length > 0 ? vaultPool : [];
      const segments = noSignals || taggableSignals.length === 0
        ? [{ type: "text", content: firstRunBrief }]
        : await tagBriefSegments(firstRunBrief, taggableSignals);

      return res.status(200).json({
        brief: firstRunBrief,
        segments,
        transparency: null,
        // First-run is deliberately starved; no overflow context to
        // surface beyond the welcome brief itself.
        theRead: null,
        household: householdId,
        user: userName,
        isFirstRun: true,
        isSingleMember,
        noSignals,
      });
    }

    // Conflict detection runs only on the steady-state path — first-run
    // is deliberately starved and reaches its own early-return above.
    const conflicts = detectConflicts({
      activeSignals,
      allDeadlines,
      calendarEvents: Array.isArray(calendarEvents) ? calendarEvents : [],
      householdNameMap,
      requestingUserId: userId,
    });

    const conflictLines =
      conflicts.length > 0
        ? conflicts
            .map((c) => {
              // Ownership tag drives second-person vs name-of-other-
              // member vs neutral-household framing. Same routing the
              // rest of the prompt uses (formatSignal et al.). Without
              // this prefix, Claude anchors on the conflict's framing
              // and defaults to "your X" even when the signal belongs
              // to another household member — verified failure mode
              // with Sarah's seeded travel_conflict before this fix.
              // Vault items don't carry userId (household-level), so
              // they fall through to HOUSEHOLD.
              const owner = isSingleMember
                ? "YOURS"
                : c.signal
                ? ownershipTag(c.signal, userId, householdNameMap, isSingleMember)
                : "HOUSEHOLD";
              const desc =
                c.signal?.description || c.item?.description || "Unknown";
              const base = `- [${owner}] ${c.type}: ${desc} — ${c.reason || "timing conflict"}`;
              // Vault items carry a `consequence` string ("membership
              // lapses", "premium auto-charged to card on file") that
              // calibrates how seriously the deadline reads. Surface it
              // in the prompt so Claude can use the stakes to choose
              // tone — without quoting the field verbatim.
              if (c.item?.consequence) {
                return `${base} (if missed: ${c.item.consequence})`;
              }
              // Travel conflicts gain a lot from naming what they
              // collide with — otherwise Claude has to guess the
              // counterpart from the rest of the prompt. Tag the
              // conflicting signal's owner too so multi-member
              // collisions read correctly ("Sarah's flight collides
              // with [HOUSEHOLD] Window cleaner appointment").
              if (c.conflictingSignal?.description) {
                const collOwner = ownershipTag(
                  c.conflictingSignal,
                  userId,
                  householdNameMap,
                  isSingleMember
                );
                return `${base} (collides with: [${collOwner}] ${c.conflictingSignal.description})`;
              }
              return base;
            })
            .join("\n")
        : "None";

    const layeredContext = [
      `Today is ${today}.`,
      ``,
      `CONFLICTS DETECTED (surface these naturally and specifically — these are the most important things to mention):`,
      conflictLines,
      ``,
      `URGENT (surface first if present):`,
      urgentForPrompt.length > 0 ? urgentForPrompt.map(formatSignal).join("\n") : "None",
      ``,
      `HEALTH CONTEXT (one sentence if notable, silent if normal):`,
      healthContext ? JSON.stringify(healthContext) : "Not connected",
      ``,
      `WEATHER TODAY (silent unless it changes what someone should do about a signal):`,
      weather ? weather.summary : "Unknown",
      ``,
      `CHILDCARE (mention if affects today or tomorrow):`,
      childcareEvents.length > 0 ? childcareEvents.map(formatEvent).join("\n") : "None",
      ``,
      `CREW (children and pets — mention only if relevant today or tomorrow, never daily routine):`,
      crewToday.length > 0 ? crewToday.map(formatCrewLine).join("\n") : "None",
      ``,
      `IN-PERSON HOME REQUIREMENTS (flag if nobody confirmed home):`,
      homeRequirements.length > 0
        ? homeRequirements
            .map((s) => `- ${s.description || "Unknown"} | ${etaWithFriendly(s.eta)}`)
            .join("\n")
        : "None",
      ``,
      `NEAR WINDOW — next 14 days:`,
      nearForPrompt.length > 0 ? nearForPrompt.map(formatSignal).join("\n") : "Nothing in the near window",
      ``,
      `FLAGGED CATEGORIES:`,
      Object.keys(flaggedSignals).length > 0 ? JSON.stringify(flaggedSignals) : "No flagged categories set",
      ``,
      `CARRIED FORWARD FROM YESTERDAY (quiet note, end of brief before horizon, only if present):`,
      carriedForwardSignals.length > 0
        ? carriedForwardSignals.map(formatSignal).join("\n")
        : "None",
      ``,
      `HORIZON SIGNAL (one sentence, end of brief, surprising, specific):`,
      horizonSignal
        ? `- ${horizonSignal.description || "Unknown"} | ETA/Deadline: ${etaWithFriendly(horizonSignal.eta)}`
        : "None this week",
      ``,
      `HORIZON AWARENESS (mention at most once, at end of brief, one sentence only):`,
      horizonAwarenessSignal
        ? `- ${horizonAwarenessSignal.description || "Unknown"} | ETA: ${etaWithFriendly(horizonAwarenessSignal.eta)}`
        : "None",
      ``,
      `FEEDBACK HISTORY: Takeoff thumbs up: ${
        (rawFeedbackStats && rawFeedbackStats.takeoff_up) || 0
      }, thumbs down: ${
        (rawFeedbackStats && rawFeedbackStats.takeoff_down) || 0
      }. Clearance thumbs up: ${
        (rawFeedbackStats && rawFeedbackStats.clearance_up) || 0
      }, thumbs down: ${
        (rawFeedbackStats && rawFeedbackStats.clearance_down) || 0
      }.`,
    ].join("\n");

    const baseRules = `RULES:
- CRITICAL RULE: Maximum 5 sentences. Count every sentence including the final one. If you reach 5 sentences, stop. Do not add a 6th sentence under any circumstances. A 4-sentence brief is better than a 6-sentence brief.
- Synthesize all layers into flowing prose — never a list
- Lead with urgent if present
- A detected conflict should always appear in the brief if it is high severity
- Medium severity conflicts appear if there is space in the brief
- Never mention work meetings or schedules directly — say "the afternoon looks tight" not "you have meetings"
- Always suggest a specific resolution when mentioning a conflict
- If conflicts exist, lead with the most severe one. Be specific about what the conflict is and what action would resolve it. Never be alarmist — calm and actionable.
- Health context: one sentence only if genuinely notable — silent if normal. If sleep.duration is under 6 hours, surface it in a calm, day-shaping way (e.g. "${userName} slept under six hours last night — worth keeping the day manageable"). If hrv.current is meaningfully below hrv.baseline7d (roughly 15% or more lower), surface it as a recovery cue (e.g. "Recovery looks low today — a lighter afternoon might serve you well"). Never quote specific numbers, percentages, or units — only contextual observations. If both sleep and HRV look normal (or data is missing), say nothing about health.
- Weather: use weather as context only when it changes what someone should do about a signal. (a) If WEATHER TODAY is rain/showers/thunderstorm AND any outdoor service appointment is scheduled today/tomorrow, mention timing may be affected. (b) If extreme heat (>90°F) AND an HVAC service is scheduled, mention this is good timing for the service. (c) If rain/storm AND any package delivery is arriving today, mention packages may need to be brought in promptly. (d) Otherwise — including all "normal" weather (clear, partly cloudy, mild temperatures) and any case where no signal would actually be affected — say absolutely nothing about weather. Do NOT mention weather as a closing flourish, do NOT use weather as an "everything's fine otherwise" transition, do NOT describe weather to round out a paragraph, do NOT include phrases like "the day is clear and warm" or "with the nice weather" or "given the calm forecast." A brief without any weather mention reads correctly when weather isn't load-bearing — the reader will not notice it's missing. Never lead with weather. Never quote the temperature or condition string verbatim — paraphrase ("the rain coming through this afternoon") rather than restate ("72°F, Rain"). When in doubt about whether weather is load-bearing, omit it.
- Childcare: mention only if it affects coordination today or tomorrow
- Crew (children and pets): Crew members surface in the brief only when something is happening today or tomorrow that requires the household to act or be present. Never mention routine pickups or recurring activities unless there is a conflict or timing consideration. A pet vet appointment today is as important as a child's activity.
- Home requirements: flag naturally if service window conflicts with likely schedule
- Carried forward: if CARRIED FORWARD FROM YESTERDAY is populated, weave in one understated sentence near the end (before the horizon line) — e.g. "Carrying forward from yesterday: the HVAC appointment is still unconfirmed." Never alarming, never repetitive of the main brief narrative. If multiple carry-forwards exist, name at most one or two; the rest are implied.
- Horizon signal: one sentence at the end, tonal shift to future-aware, specific and surprising
- Horizon awareness: if HORIZON AWARENESS is populated, surface it as one quiet sentence near the end (a "by the way..." not a lead). If both HORIZON SIGNAL and HORIZON AWARENESS are populated, prefer HORIZON AWARENESS — at most one horizon-style sentence per brief total.
- Feedback tuning: the FEEDBACK HISTORY counts reflect how prior briefs landed. If thumbs-down significantly outnumbers thumbs-up for this brief type (takeoff or clearance, depending on which you're writing), be more concise and specific — trim discretionary sentences, lean harder into the most concrete signals. If thumbs-up is high or both counts are low, maintain current voice. Never reference the feedback in the brief output.
- If multiple layers are silent, the brief is shorter — that is correct and good
- A quiet brief is a gift — end with confidence not apology
- Never say "here is your brief" or use assistant language
- Never reference your own process, scanning, monitoring, or pipeline
- Never say you are looking for signals, watching for signals, or running sweeps
- Never use the words: alert, monitor, scan, detect, pipeline, sweep, system, tracking
- Simply say what you know. Never explain how you know it.
- When mentioning a future event more than 7 days out, end that sentence with one of these phrases naturally woven in: "worth watching", "Conductor has its eye on this", "it's on the radar", "watching for it", or "we'll flag it as it gets closer". Choose the phrase that fits most naturally. Never use the same phrase twice in one brief. Two constraints on these phrases: (a) "has its eye on this" REQUIRES "Conductor" as the subject — never drop the name and never substitute another subject ("the subscription has its eye on this" is wrong); (b) "we'll flag it" REQUIRES the implicit subject to be Conductor — don't rephrase to "you'll flag it" or "they'll flag it." If you want to vary the subject, pick a different phrase from the list instead.
- Plain text only, no markdown
- Do not begin with date or header
- Personalize to ${userName} — use "you" naturally
${isSingleMember
  ? `- This is a single-person household. Always use "you" and "your" throughout. Never refer to any other household member by name. All signals belong to you. The bracket tag will always be [YOURS] — never include the bracket tag in the brief.`
  : `- Ownership tags: every signal, deadline, and calendar event is prefixed with [YOURS], a household member's name in the form [NAME'S], or [HOUSEHOLD]. When the tag is [YOURS], speak in second person — "your spray tan tonight." When it's [SARAH'S] (or any other name), use that person's first name naturally — "Sarah has a spray tan tonight." When it's [HOUSEHOLD], use neutral household framing — "the vehicle registration renewal is due Wednesday." Flagged-categories signals carry an "owner" field with the same possible values; treat it identically. NEVER include the bracket tags or the literal word "owner" in the brief — they're routing metadata.`}
- When referring to a future date, lift the day-and-date verbatim from the friendly string already provided in the ETA field (e.g., "Sunday, May 10"). NEVER compute, infer, or recalculate a day-of-week or date — the resolved string is authoritative. Ignore the "raw:" portion. Drop the year unless it differs from the current year.
- If a signal's ETA is "Unknown" or missing, do NOT invent or guess a date for it — even if the description mentions a holiday or named event. Either omit the date or use a phrase like "no confirmed date yet". Do NOT translate "Mother's Day", "the weekend", or similar phrases into specific calendar dates yourself.
- When two future-dated items appear in the same brief, do NOT characterize the gap between them with a relative-duration phrase like "two weeks later", "a month later", "a few days after", or "soon after". The dates already convey the timing, and these phrases frequently miscount (May 20 → May 28 is eight days, not two weeks). Use "the following" or "and another" for sequential framing, or just let the dates stand on their own.
- The ETA friendly field includes an authoritative day-count phrase in parentheses like "(in 6 days)", "(today)", or "(tomorrow)". If you want to convey how soon something is, lift that phrase VERBATIM. The ONLY two acceptable timing forms in the brief are: (1) the lifted parenthesized phrase verbatim, and (2) the day-and-date ("Wednesday, May 20"). Any other quantified duration is forbidden — this is a PATTERN rule, not a list-of-examples rule. The forbidden pattern is "<number-or-quantifier> <time-unit> <preposition>" where number-or-quantifier is anything like "5", "five", "a", "a couple of", "several", "a few", "about two", time-unit is days/weeks/months/years (singular OR plural), and preposition is away/out/left/remaining/from now/to <verb>/until <date>/later/before. Non-exhaustive examples that are ALL forbidden: "in 5 days" (if not lifted), "five days away", "5 days out", "five days left", "five days to renew", "two weeks later", "two weeks out", "two weeks away", "two weeks left", "in two weeks", "a week out", "a couple of weeks away", "in about three weeks", "a few days from now", "next week", "soon", "shortly". If you find yourself constructing any duration phrase that isn't the lifted parenthesized phrase, stop and use the date alone instead — the day-and-date is always sufficient on its own.
- The parenthesized phrase also surfaces past dates as "(yesterday)" or "(already passed N days ago)". Treat these signals as already-happened, NOT upcoming. Never write "looking ahead to..." or "her trip is set for..." or "watch for it as the date approaches" about a past-dated item — those framings are reserved for genuinely future dates. A past-dated signal usually means it's still open or unresolved (e.g., a delivery that never arrived, an appointment that wasn't marked done); if it warrants mention, frame it as a stale-or-outstanding item ("the spray tan from last Thursday hasn't been confirmed resolved", or simply omit). If a past-dated item has no actionable open thread, omit it entirely — do not pad the brief with retrospective recaps.`;

    // First-run is handled by an early-return branch above; this path is
    // always the steady-state pipeline.
    const userPrompt = `${layeredContext}\n\n${baseRules}`;

    const systemPrompt = `You are Conductor, a household intelligence layer. You write calm, trusted, personal morning briefs for ${userName}. Your voice is like a thought the reader was already having — never assistant-like, never listy, always prose.`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    const data = await response.json();
    const brief = (data && data.content && data.content[0] && data.content[0].text) || "";

    // Stash the most-recent generated brief at a stable key with a 48h TTL
    // so the Yesterday's Programme modal can always recover it. Naming is
    // product copy ("yesterday") rather than literal — the key holds the
    // most recent run and gets overwritten on each subsequent generation.
    if (brief) {
      await redis.set(`household:${householdId}:yesterdayTakeoff`, brief, { ex: 48 * 60 * 60 });
    }

    // Tag clickable signal phrases — pass everything that could plausibly appear.
    const tagPool = [...urgentForPrompt, ...nearForPrompt, ...homeRequirements, ...carriedForwardSignals];
    if (horizonSignal) tagPool.push(horizonSignal);
    if (horizonAwarenessSignal) tagPool.push(horizonAwarenessSignal);
    // dedupe by id
    const seen = new Set();
    const tagSignals = tagPool.filter((s) => {
      const key = String(s.id);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // Run segment tagging, transparency, and The Read generation in
    // parallel — all three depend only on the brief text and existing
    // pools, so there's no ordering constraint between them. Saves
    // ~two Claude round-trips of latency vs sequential.
    const poolsForClaude = {
      urgent: urgentForPrompt,
      near: nearForPrompt,
      healthContext,
      weather: weather ? weather.summary : null,
      childcare: childcareEvents,
      homeRequirements,
      horizon: horizonAwarenessSignal || horizonSignal,
      carriedForward: carriedForwardSignals,
    };
    const [segments, transparency, theRead] = await Promise.all([
      tagBriefSegments(brief, tagSignals),
      generateTransparency(brief, poolsForClaude),
      generateTheRead(brief, poolsForClaude),
    ]);

    // Track which signals Claude actually narrated this run so the next brief
    // knows what to mute. Lookup uses the union of pools we considered, since
    // a signal can land in segments from any of them.
    const signalLookup = new Map();
    for (const s of [...activeSignals, ...allDeadlines]) {
      signalLookup.set(String(s.id), s);
    }
    if (horizonSignal) signalLookup.set(String(horizonSignal.id), horizonSignal);
    if (horizonAwarenessSignal) {
      signalLookup.set(String(horizonAwarenessSignal.id), horizonAwarenessSignal);
    }

    const briefedTodayKey = `household:${householdId}:briefedToday`;
    const briefedTodayFields = {};
    for (const seg of segments || []) {
      if (!seg || seg.type !== "signal" || seg.signalId == null) continue;
      const id = String(seg.signalId);
      const sig = signalLookup.get(id);
      if (!sig) continue;
      briefedTodayFields[id] = JSON.stringify({
        status: sig.status || "",
        state: sig.state || "",
        ring: computeRing(sig),
      });
    }
    if (Object.keys(briefedTodayFields).length > 0) {
      await redis.hset(briefedTodayKey, briefedTodayFields);
      // Refresh TTL so a signal that keeps appearing stays muted; once it
      // stops appearing the entire hash drops in 20 hours.
      await redis.expire(briefedTodayKey, 20 * 60 * 60);

      // morningBriefed mirrors the same shape but with a 26h TTL so it
      // survives until tomorrow morning and clearance can read it tonight to
      // build the LAST CHANCE pool. Distinct from briefedToday, which
      // clearance also writes into and which has shorter TTL purely for
      // narration-mute purposes.
      const morningBriefedKey = `household:${householdId}:morningBriefed`;
      await redis.hset(morningBriefedKey, briefedTodayFields);
      await redis.expire(morningBriefedKey, 26 * 60 * 60);
    }

    // Acknowledge the horizon-awareness pick for the week. We mark it whether
    // or not Claude explicitly inlined it — the prompt budget is already spent
    // and re-offering the same signal next morning would feel repetitive.
    if (horizonAwarenessSignal) {
      const briefedThisWeekKey = `household:${householdId}:briefedThisWeek`;
      await redis.sadd(briefedThisWeekKey, String(horizonAwarenessSignal.id));
      await redis.expire(briefedThisWeekKey, 6 * 24 * 60 * 60);
    }

    return res.status(200).json({
      brief,
      segments,
      transparency,
      theRead,
      household: householdId,
      user: userName,
      isFirstRun,
      isSingleMember,
    });
  } catch (error) {
    console.error("Brief error:", error);
    return res.status(500).json({ error: "Failed to generate brief" });
  }
}
