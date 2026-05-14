import { Redis } from "@upstash/redis";
import { loadHouseholdCalendar } from "./calendar-loader.js";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Same shape as brief.js's generateTransparency, with clearance-specific
// pool labels. Best-effort: returns null on any failure so the response
// still ships the prose without a transparency entry.
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

  const prompt = `You just generated this evening brief: ${brief}

The signals you considered were:
Rested today: ${briefList(pools.resolvedToday)}
Lapsed today: ${briefList(pools.expiredToday)}
Still in motion: ${briefList(pools.stillActive)}
Delayed: ${briefList(pools.carryingForward)}
Imminent deadlines: ${briefList(pools.urgentDeadlines)}
Near deadlines: ${briefList(pools.nearDeadlines)}
Last chance (still open from today): ${briefList(pools.lastChance)}
Tomorrow's calendar: ${eventList(pools.tomorrow)}
Horizon: ${pools.horizon ? `- ${pools.horizon.description || "Unknown"}` : "(none)"}

Write a plain-language explanation of how you thought about closing the day. Cover:
1. What you included and why (1-2 sentences)
2. What you excluded and why (1 sentence)
3. What you're watching that didn't make the brief (1 sentence)

Rules:
- Write in first person as Conductor — "I noted..." "I left out..."
- Plain text only, no markdown
- Maximum 4 sentences total
- Honest and specific — name actual signals
- Calm, not defensive
- Never assert what the user said, noted, mentioned, told you, indicated, expressed, confirmed, asked, or wrote. Describe only the signals present in the pool and how you weighed them. If you want to convey a user state, frame it as your own inference: "I inferred X" or "this reads like X" — never "you noted X".`;

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
    console.error("Clearance transparency generation failed:", err);
    return null;
  }
}

async function tagBriefSegments(brief, signals) {
  const fallback = [{ type: "text", content: brief || "" }];
  if (!brief || !signals || signals.length === 0) return fallback;

  const signalList = signals
    .map(s => `- id: ${s.id} | type: ${s.type || "unknown"} | description: ${s.description || "Unknown"}`)
    .join("\n");

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

Split the brief exactly — every character must appear in exactly one segment. Signal phrases should be the natural language reference to that signal as it appears in the brief (e.g. 'hair styling items' not the full description). Only tag phrases that clearly refer to a specific signal. Return only the JSON array, nothing else.

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
      .map(seg => (seg && typeof seg.content === "string" ? seg.content : ""))
      .join("");
    if (rejoined !== brief && rejoined.trim() !== brief.trim()) return fallback;

    return parsed;
  } catch (err) {
    console.error("Segment tagging failed:", err);
    return fallback;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Replicated from brief.js so the briefedToday hash uses identical ring
// values regardless of which endpoint wrote the snapshot. Keep these in
// sync if brief.js's logic changes.
function dayOffsetFromTodayUtil(date) {
  const a = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const now = new Date();
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((a.getTime() - t.getTime()) / DAY_MS);
}
function withinNextDaysUtil(date, days) {
  const ms = date.getTime() - Date.now();
  return ms <= days * DAY_MS && ms > -DAY_MS;
}
function classifyUrgentUtil(s) {
  if (s.priority === "urgent") return true;
  const eta = parseDateLoose(s.eta);
  if (!eta) return false;
  const offset = dayOffsetFromTodayUtil(eta);
  if (offset === 0) {
    if (s.type === "service" || s.type === "reservation") return true;
    if (s.status === "Out for Delivery") return true;
  }
  if (s.type === "deadline" && withinNextDaysUtil(eta, 3)) return true;
  return false;
}
function isInNearWindowUtil(s) {
  if (s.status === "Delivered") return false;
  const eta = parseDateLoose(s.eta);
  if (!eta) return true;
  return withinNextDaysUtil(eta, 14);
}
function computeRing(s) {
  if (classifyUrgentUtil(s)) return "inner";
  if (isInNearWindowUtil(s)) return "middle";
  return "outer";
}

// Replicated from brief.js — keep the two implementations identical so the
// ownership tag a user sees in the morning matches what they see at evening.
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

function ownershipTag(item, requestingUserId, nameMap, isSingleMember = false) {
  if (isSingleMember) return "YOURS";
  if (!item || !item.userId) return "HOUSEHOLD";
  if (item.userId === requestingUserId) return "YOURS";
  const firstName = nameMap.get(item.userId);
  if (firstName) return `${firstName.toUpperCase()}'S`;
  return "HOUSEHOLD";
}

function isSameDay(d1, d2) {
  return d1.getFullYear() === d2.getFullYear()
    && d1.getMonth() === d2.getMonth()
    && d1.getDate() === d2.getDate();
}

function parseDateLoose(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return isNaN(ms) ? null : new Date(ms);
}

function safeJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return null; }
}

function friendlyDate(value) {
  const d = parseDateLoose(value);
  if (!d) return null;
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function friendlyDateTime(value) {
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
}

function etaWithFriendly(raw) {
  if (!raw) return "Unknown";
  const friendly = friendlyDate(raw);
  return friendly ? `${friendly} (raw: ${raw})` : raw;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { userId } = req.query;

  try {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
    const dayAfter = new Date(today.getTime() + 2 * 24 * 60 * 60 * 1000);

    let householdId = "RangerOaks925";
    if (userId) {
      const hid = await redis.get(`user:${userId}:household`);
      if (hid) householdId = hid;
    }

    const [
      rawSignals,
      rawCal,
      rawDeadlines,
      rawHorizon,
      rawBriefed,
      rawBriefedToday,
      rawMorningBriefed,
      householdNameMap,
      rawFeedbackStats,
      rawMembers,
    ] = await Promise.all([
      redis.lrange(`household:${householdId}:signals`, 0, -1),
      // Multi-driver: returns a merged event array (or [] when empty),
      // not a JSON string. The downstream typeof check on rawCal still
      // handles both shapes correctly.
      loadHouseholdCalendar(redis, householdId),
      redis.lrange(`household:${householdId}:deadlines`, 0, -1),
      redis.get(`household:${householdId}:horizon`),
      redis.lrange(`household:${householdId}:briefed`, 0, -1),
      redis.hgetall(`household:${householdId}:briefedToday`),
      redis.hgetall(`household:${householdId}:morningBriefed`),
      buildHouseholdNameMap(redis, householdId, userId),
      redis.hgetall(`household:${householdId}:feedbackStats`),
      // Single-member households collapse all ownership tags to YOURS;
      // mirrors the brief.js path.
      redis.smembers(`household:${householdId}:members`),
    ]);
    const isSingleMember = (rawMembers || []).length <= 1;

    const signals = (rawSignals || []).map(s => typeof s === "string" ? JSON.parse(s) : s);
    const briefedIds = new Set((rawBriefed || []).map(s => String(s)));

    // briefedToday hash shared with brief.js — same shape, same TTL. We use it
    // here to mute signals already narrated in the morning brief whose
    // status/state/ring haven't shifted since.
    const briefedTodayMap =
      (rawBriefedToday && typeof rawBriefedToday === "object") ? rawBriefedToday : {};
    function previousSnapshot(s) {
      const raw = briefedTodayMap[String(s.id)];
      if (raw == null) return null;
      if (typeof raw === "string") {
        try { return JSON.parse(raw); } catch { return null; }
      }
      return raw;
    }
    function isBackgroundFiltered(s) {
      const prev = previousSnapshot(s);
      if (!prev) return false;
      const sameStatus = (prev.status || "") === (s.status || "");
      const sameState = (prev.state || "") === (s.state || "");
      const sameRing = (prev.ring || "") === computeRing(s);
      return sameStatus && sameState && sameRing;
    }

    const resolvedToday = [];
    const expiredToday = [];
    const stillActive = [];
    const carryingForward = [];

    for (const s of signals) {
      const eta = parseDateLoose(s.eta);
      const lastUpdate = parseDateLoose(s.lastUpdate);

      // Resolved/expired today are state changes — never mute. They're the
      // whole point of the evening brief.
      if (s.state === "resolved" && lastUpdate && isSameDay(lastUpdate, now)) {
        resolvedToday.push(s);
        continue;
      }

      if (s.state === "expired" && s.expiredAt) {
        const expiredAt = parseDateLoose(s.expiredAt);
        if (expiredAt && isSameDay(expiredAt, now)) {
          expiredToday.push(s);
          continue;
        }
      }

      // Still-in-motion and delayed-carrying signals are stable shapes — skip
      // narration when nothing's changed since the last brief.
      if ((s.state === "incoming" || s.state === "active") && eta && eta > now) {
        if (!isBackgroundFiltered(s)) stillActive.push(s);
      }

      if (
        s.status === "Delayed" &&
        s.state !== "expired" &&
        s.state !== "resolved" &&
        (!eta || eta > now) &&
        !isBackgroundFiltered(s)
      ) {
        carryingForward.push(s);
      }
    }

    // LAST CHANCE pool — signals worth one final calm acknowledgment as the
    // day closes. Sources:
    //   1. Anything we narrated this morning that's still incoming/active.
    //   2. Anything currently on the Act Now ring today (ETA today/overdue,
    //      state incoming/active) — even if it wasn't in the morning brief.
    // Dedupe by ID; same key (lastChancePool) feeds both the prompt and the
    // clearanceBriefed writeback below.
    const morningBriefedMap =
      (rawMorningBriefed && typeof rawMorningBriefed === "object") ? rawMorningBriefed : {};
    const morningBriefedIds = new Set(Object.keys(morningBriefedMap));
    const endOfToday = new Date(today.getTime() + DAY_MS - 1);
    const lastChanceById = new Map();
    for (const s of signals) {
      const stillOpen = !s.state || s.state === "incoming" || s.state === "active";
      if (!stillOpen) continue;
      const inMorning = morningBriefedIds.has(String(s.id));
      const eta = parseDateLoose(s.eta);
      const onActNowToday = !!eta && eta <= endOfToday;
      if (inMorning || onActNowToday) {
        lastChanceById.set(String(s.id), s);
      }
    }
    const lastChancePool = [...lastChanceById.values()];

    let tomorrowEvents = [];
    if (rawCal) {
      const allEvents = typeof rawCal === "string" ? JSON.parse(rawCal) : rawCal;
      tomorrowEvents = allEvents.filter(e => {
        if (!e.householdRelevant) return false;
        const start = parseDateLoose(e.start);
        return start && start >= tomorrow && start < dayAfter;
      });
    }

    // DEADLINES — pull from :deadlines and classify into urgent / near / horizon.
    // 1-3 days → urgent ("imminent"), 4-14 days → near, 15-90 days → horizon
    // candidate (only used if no fresh stored horizon). Deduped against existing
    // signal descriptions so we don't double-report things already in the pipeline.
    const allDeadlines = (rawDeadlines || []).map(safeJson).filter(Boolean);
    const existingSignalDescs = new Set(
      signals
        .map(s => (s.description || "").toLowerCase().trim())
        .filter(Boolean)
    );

    function isSimilarToExistingSignal(desc) {
      if (!desc) return false;
      if (existingSignalDescs.has(desc)) return true;
      for (const sd of existingSignalDescs) {
        if (sd.length >= 6 && desc.length >= 6 && (sd.includes(desc) || desc.includes(sd))) return true;
      }
      return false;
    }

    const urgentDeadlines = [];
    const nearDeadlines = [];
    const horizonDeadlineCandidates = [];

    for (const d of allDeadlines) {
      const eta = parseDateLoose(d.eta);
      if (!eta) continue;
      const desc = (d.description || "").toLowerCase().trim();
      if (isSimilarToExistingSignal(desc)) continue;
      const days = (eta.getTime() - Date.now()) / DAY_MS;
      const tagged = { ...d, _isDeadline: true, type: "deadline" };
      if (days >= -1 && days <= 3) urgentDeadlines.push(tagged);
      else if (days > 3 && days <= 14) {
        // Near-window deadlines apply the same mute rule.
        if (!isBackgroundFiltered(tagged)) nearDeadlines.push(tagged);
      }
      else if (days >= 15 && days <= 90 && !briefedIds.has(String(d.id))) {
        horizonDeadlineCandidates.push(tagged);
      }
    }

    // HORIZON — fresh cached one wins; otherwise pick the closest of the 15-90 day
    // candidates and persist it.
    let horizonSignal = null;
    const storedHorizon = safeJson(rawHorizon);
    const horizonFresh =
      storedHorizon &&
      typeof storedHorizon.timestamp === "number" &&
      Date.now() - storedHorizon.timestamp < 7 * DAY_MS;
    if (horizonFresh) {
      horizonSignal = storedHorizon.signal;
    } else if (horizonDeadlineCandidates.length > 0) {
      horizonDeadlineCandidates.sort(
        (a, b) => parseDateLoose(a.eta).getTime() - parseDateLoose(b.eta).getTime()
      );
      horizonSignal = horizonDeadlineCandidates[0];
      await redis.set(
        `household:${householdId}:horizon`,
        JSON.stringify({ signal: horizonSignal, timestamp: Date.now() })
      );
      await redis.lpush(`household:${householdId}:briefed`, String(horizonSignal.id));
    }

    let userName = "there";
    if (userId) {
      const profile = await redis.get(`user:${userId}:profile`);
      if (profile) {
        const p = typeof profile === "string" ? JSON.parse(profile) : profile;
        userName = p.name?.split(" ")[0] || "there";
      }
    }

    // Resolve raw timestamps server-side so Claude never has to compute day-of-week
    // or date arithmetic. The model just lifts the friendly string into the prose.
    const fmt = s => {
      const owner = `[${ownershipTag(s, userId, householdNameMap, isSingleMember)}]`;
      if (s._isDeadline) {
        return `- ${owner} [DEADLINE] ${s.description || "Unknown"} | Due: ${etaWithFriendly(s.eta)} | Category: ${s.category || "uncategorized"}`;
      }
      return `- ${owner} ${s.description || "Unknown item"} from ${s.sender || "Unknown"} | Status: ${s.status || "Unknown"} | ETA: ${etaWithFriendly(s.eta)} | Type: ${s.type || "unknown"}`;
    };

    const resolvedSummary = resolvedToday.map(fmt).join("\n");
    const expiredSummary = expiredToday.map(fmt).join("\n");
    const activeSummary = stillActive.map(fmt).join("\n");
    const delayedSummary = carryingForward.map(fmt).join("\n");
    const urgentDeadlineSummary = urgentDeadlines.map(fmt).join("\n");
    const nearDeadlineSummary = nearDeadlines.map(fmt).join("\n");
    const horizonSummary = horizonSignal
      ? fmt({ ...horizonSignal, _isDeadline: true })
      : "";
    const lastChanceSummary = lastChancePool.map(fmt).join("\n");

    const tomorrowSummary = tomorrowEvents
      .map(e => {
        const owner = `[${ownershipTag(e, userId, householdNameMap, isSingleMember)}]`;
        const friendly = friendlyDateTime(e.start);
        const when = friendly || (e.start ? `raw: ${e.start}` : "Unknown");
        return `- ${owner} ${e.title} | ${when}`;
      })
      .join("\n");

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
        messages: [{
          role: "user",
          content: `You are Conductor, a household intelligence layer. Write a calm, reflective evening brief for ${userName} as the day closes.

Rested or arrived today:
${resolvedSummary || "None"}

Lapsed today (didn't arrive as expected):
${expiredSummary || "None"}

Still in motion (future ETA):
${activeSummary || "None"}

Delayed and carrying forward:
${delayedSummary || "None"}

Imminent deadlines (next 3 days — surface these clearly):
${urgentDeadlineSummary || "None"}

Deadlines in the near window (4-14 days):
${nearDeadlineSummary || "None"}

On the horizon (one surprising deadline 15-90 days out, optional final note):
${horizonSummary || "None"}

Important: ignore promotional events, store launches, marketing emails, and account/loyalty signals. Only narrate signals that represent real deliveries, services, reservations, or travel — things with a concrete arrival, commitment, or action. Deadlines (marked [DEADLINE]) are documents/renewals/registrations the user needs to handle — surface them naturally in the close-of-day reflection.

LAST CHANCE (end of brief, only if non-empty): One calm sentence acknowledging signals that are still open from today. Not alarming. Something like: "Before you close out — [description] still needs attention if you haven't gotten to it." Maximum one sentence, only if there are genuinely open signals.
${lastChanceSummary || "None"}

On the household calendar tomorrow:
${tomorrowSummary || "None"}

FEEDBACK HISTORY: Takeoff thumbs up: ${
        (rawFeedbackStats && rawFeedbackStats.takeoff_up) || 0
      }, thumbs down: ${
        (rawFeedbackStats && rawFeedbackStats.takeoff_down) || 0
      }. Clearance thumbs up: ${
        (rawFeedbackStats && rawFeedbackStats.clearance_up) || 0
      }, thumbs down: ${
        (rawFeedbackStats && rawFeedbackStats.clearance_down) || 0
      }.

Rules:
- Write in natural, flowing prose — not a list
- 3-5 sentences maximum
- Lead with what rested or arrived today
- Note what's still in motion without alarm — these are simply continuing
- Surface anything important tomorrow so it lands gently in advance
- Skip signals with no useful information
- Tone: reflective, closing the day, like a thought ${userName} was already having as the evening settles
- Feedback tuning: the FEEDBACK HISTORY counts reflect how prior briefs landed. If clearance thumbs-down significantly outnumbers clearance thumbs-up, be more concise and specific — trim discretionary sentences. If thumbs-up is high or both counts are low, maintain current voice. Never reference the feedback in the output.
${isSingleMember
  ? `- This is a single-person household. Always use "you" and "your" throughout. Never refer to any other household member by name. All signals belong to you. The bracket tag will always be [YOURS] — never include the bracket tag in the brief output.`
  : `- Ownership tags: every signal, deadline, and event is prefixed [YOURS], [NAME'S] (a household member), or [HOUSEHOLD]. When the tag is [YOURS], speak in second person — "your spray tan tonight." When it's [NAME'S], use that person's first name naturally — "Sarah's spray tan went well." When it's [HOUSEHOLD], use neutral framing. NEVER include the bracket tags in the brief output — they're routing metadata.`}
- Never say "here is your brief" or use assistant language
- Never reference your own process, scanning, monitoring, or pipeline
- Never say you are looking for signals, watching for signals, or running sweeps
- Never use the words: alert, monitor, scan, detect, pipeline, sweep, system, tracking
- Simply say what you know. Never explain how you know it.
- When mentioning a future event more than 7 days out, end that sentence with one of these phrases naturally woven in: "worth watching", "Conductor has its eye on this", "it's on the radar", "watching for it", or "we'll flag it as it gets closer". Choose the phrase that fits most naturally. Never use the same phrase twice in one brief.
- Output plain text only. No markdown. No hashtags. No headers.
- Do not begin with a date or header. Start directly with the first sentence.
- If nothing notable happened or is coming, say so confidently — a quiet day is a real outcome
- End with something that closes the day — calm, done, ready for tomorrow
- When referring to a future date, lift the day-and-date verbatim from the friendly string already provided in the ETA field (e.g., "Sunday, May 10"). NEVER compute, infer, or recalculate a day-of-week or date — the resolved string is authoritative. Ignore the "raw:" portion. Drop the year unless it differs from the current year.
- If a signal's ETA is "Unknown" or missing, do NOT invent or guess a date for it — even if the description mentions a holiday or named event. Either omit the date or use a phrase like "no confirmed date yet". Do NOT translate "Mother's Day", "the weekend", or similar phrases into specific calendar dates yourself.`,
        }],
      }),
    });

    const data = await response.json();
    const brief = data.content[0].text;

    // Mirror of brief.js — stash the most-recent clearance at a 48h key so
    // the Yesterday's Programme modal can recover it.
    if (brief) {
      await redis.set(`household:${householdId}:yesterdayClearance`, brief, { ex: 48 * 60 * 60 });
    }

    const tagPool = [
      ...resolvedToday,
      ...expiredToday,
      ...stillActive,
      ...carryingForward,
      ...urgentDeadlines,
      ...nearDeadlines,
      ...lastChancePool,
    ];
    if (horizonSignal) tagPool.push(horizonSignal);
    // Dedupe by id — lastChancePool overlaps with stillActive/carryingForward
    // by design, and Claude's segment tagger gets confused when the same
    // signal appears multiple times with the same id but slightly different
    // descriptions, falling back to the plain-text path.
    const seen = new Set();
    const tagSet = tagPool.filter((s) => {
      const key = String(s.id);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // Run segment tagging and transparency generation in parallel.
    const [segments, transparency] = await Promise.all([
      tagBriefSegments(brief, tagSet),
      generateTransparency(brief, {
        resolvedToday,
        expiredToday,
        stillActive,
        carryingForward,
        urgentDeadlines,
        nearDeadlines,
        lastChance: lastChancePool,
        tomorrow: tomorrowEvents,
        horizon: horizonSignal,
      }),
    ]);

    // Write narrated signal snapshots into the shared briefedToday hash so the
    // morning brief knows what's already been said. Same shape, same TTL as
    // brief.js. State-change pools (resolvedToday, expiredToday) intentionally
    // get written too — if the signal stays resolved/expired tomorrow morning,
    // it's the right behavior to keep silent about it.
    const signalLookup = new Map();
    for (const s of [...signals, ...allDeadlines]) {
      signalLookup.set(String(s.id), s);
    }
    if (horizonSignal) signalLookup.set(String(horizonSignal.id), horizonSignal);

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
      await redis.expire(briefedTodayKey, 20 * 60 * 60);
    }

    // clearanceBriefed — IDs of every signal in the LAST CHANCE pool, regardless
    // of whether Claude actually mentioned each one. The morning brief reads
    // this set to mark survivors as carriedForward, so we want a complete
    // record of what was offered up at evening close, not just what got
    // narrated. 14h TTL spans evening to next morning's brief run.
    if (lastChancePool.length > 0) {
      const clearanceBriefedKey = `household:${householdId}:clearanceBriefed`;
      const lastChanceIds = lastChancePool.map(s => String(s.id));
      await redis.sadd(clearanceBriefedKey, ...lastChanceIds);
      await redis.expire(clearanceBriefedKey, 14 * 60 * 60);
    }

    return res.status(200).json({ brief, segments, transparency, household: householdId, user: userName, isSingleMember });

  } catch (error) {
    console.error("Clearance error:", error);
    return res.status(500).json({ error: "Failed to generate clearance" });
  }
}
