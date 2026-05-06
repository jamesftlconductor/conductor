import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// ---------- helpers ----------

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

async function tagBriefSegments(brief, signals) {
  const fallback = [{ type: "text", content: brief || "" }];
  if (!brief || !signals || signals.length === 0) return fallback;

  const signalList = signals
    .map((s) => `- id: ${s.id} | type: ${s.type || "unknown"} | description: ${s.description || "Unknown"}`)
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
      .map((seg) => (seg && typeof seg.content === "string" ? seg.content : ""))
      .join("");
    if (rejoined !== brief && rejoined.trim() !== brief.trim()) return fallback;

    return parsed;
  } catch (err) {
    console.error("Segment tagging failed:", err);
    return fallback;
  }
}

// ---------- handler ----------

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
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
    ] = await Promise.all([
      redis.lrange(`household:${householdId}:signals`, 0, -1),
      redis.get(`household:${householdId}:calendar`),
      userId ? redis.get(`user:${userId}:health`) : Promise.resolve(null),
      redis.get(`household:${householdId}:horizon`),
      redis.lrange(`household:${householdId}:deadlines`, 0, -1),
      redis.lrange(`household:${householdId}:briefed`, 0, -1),
      userId ? redis.get(`user:${userId}:preferences`) : Promise.resolve(null),
      redis.get(`household:${householdId}:firstRun`),
      redis.hgetall(`household:${householdId}:briefedToday`),
      redis.smembers(`household:${householdId}:briefedThisWeek`),
      redis.smembers(`household:${householdId}:clearanceBriefed`),
      redis.smembers(`household:${householdId}:carriedForward`),
    ]);

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

    // DEADLINES — pull from :deadlines and classify into urgent / near pools.
    // 1-3 days → urgent, 4-14 days → near, 15-90 days → horizon (handled below).
    // Deduped against existing signal descriptions so we don't double-report.
    const allDeadlines = (rawDeadlines || []).map(safeJson).filter(Boolean);
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
      // Tag with `_isDeadline: true` so the prompt formatter can render
      // them with the [DEADLINE] prefix and a Category field.
      const tagged = { ...d, _isDeadline: true, type: "deadline" };
      if (days >= -1 && days <= 3) urgentDeadlines.push(tagged);
      else if (days > 3 && days <= 14) {
        // Near-window deadlines get the background-filter treatment too,
        // since they are also subject to the "don't repeat last brief" rule.
        if (!isBackgroundFiltered(tagged)) nearDeadlines.push(tagged);
      }
      // 15-90 reserved for horizon; handled below.
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
          })),
          events: matchingEvents.map((e) => ({ title: e.title, start: e.start })),
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
      const deadlines = (rawDeadlines || []).map(safeJson).filter(Boolean);
      const candidates = deadlines.filter((d) => {
        if (briefedIds.has(String(d.id))) return false;
        const eta = parseDateLoose(d.eta);
        if (!eta) return false;
        const offsetDays = (eta.getTime() - Date.now()) / DAY_MS;
        // 15-90 days: 4-14 day deadlines are now in the near pool above.
        return offsetDays >= 15 && offsetDays <= 90;
      });
      if (candidates.length > 0) {
        // Most surprising — prefer the closest to the 15-day edge that hasn't been briefed.
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

    const etaWithFriendly = (raw) => {
      const friendly = friendlyDate(raw);
      if (!raw) return "Unknown";
      return friendly ? `${friendly} (raw: ${raw})` : raw;
    };

    const formatSignal = (s) => {
      if (s._isDeadline) {
        return `- [DEADLINE] ${s.description || "Unknown"} | Due: ${etaWithFriendly(s.eta)} | Category: ${s.category || "uncategorized"}`;
      }
      return `- ${s.description || "Unknown"} | ${s.status || "Unknown"} | ETA: ${etaWithFriendly(s.eta)} | Type: ${s.type || "unknown"}`;
    };
    const formatEvent = (e) => {
      const friendly = friendlyDateTime(e.start);
      const when = friendly || (e.start ? `raw: ${e.start}` : "Unknown");
      return `- ${e.title || "Untitled"} | ${when}`;
    };

    const layeredContext = [
      `Today is ${today}.`,
      ``,
      `URGENT (surface first if present):`,
      urgentForPrompt.length > 0 ? urgentForPrompt.map(formatSignal).join("\n") : "None",
      ``,
      `HEALTH CONTEXT (one sentence if notable, silent if normal):`,
      healthContext ? JSON.stringify(healthContext) : "Not connected",
      ``,
      `CHILDCARE (mention if affects today or tomorrow):`,
      childcareEvents.length > 0 ? childcareEvents.map(formatEvent).join("\n") : "None",
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
    ].join("\n");

    const baseRules = `RULES:
- Maximum 5-6 sentences total
- Synthesize all layers into flowing prose — never a list
- Lead with urgent if present
- Health context: one sentence only if genuinely notable — silent if normal. If sleep.duration is under 6 hours, surface it in a calm, day-shaping way (e.g. "${userName} slept under six hours last night — worth keeping the day manageable"). If hrv.current is meaningfully below hrv.baseline7d (roughly 15% or more lower), surface it as a recovery cue (e.g. "Recovery looks low today — a lighter afternoon might serve you well"). Never quote specific numbers, percentages, or units — only contextual observations. If both sleep and HRV look normal (or data is missing), say nothing about health.
- Childcare: mention only if it affects coordination today or tomorrow
- Home requirements: flag naturally if service window conflicts with likely schedule
- Carried forward: if CARRIED FORWARD FROM YESTERDAY is populated, weave in one understated sentence near the end (before the horizon line) — e.g. "Carrying forward from yesterday: the HVAC appointment is still unconfirmed." Never alarming, never repetitive of the main brief narrative. If multiple carry-forwards exist, name at most one or two; the rest are implied.
- Horizon signal: one sentence at the end, tonal shift to future-aware, specific and surprising
- Horizon awareness: if HORIZON AWARENESS is populated, surface it as one quiet sentence near the end (a "by the way..." not a lead). If both HORIZON SIGNAL and HORIZON AWARENESS are populated, prefer HORIZON AWARENESS — at most one horizon-style sentence per brief total.
- If multiple layers are silent, the brief is shorter — that is correct and good
- A quiet brief is a gift — end with confidence not apology
- Never say "here is your brief" or use assistant language
- Plain text only, no markdown
- Do not begin with date or header
- Personalize to ${userName} — use "you" naturally
- When referring to a future date, lift the day-and-date verbatim from the friendly string already provided in the ETA field (e.g., "Sunday, May 10"). NEVER compute, infer, or recalculate a day-of-week or date — the resolved string is authoritative. Ignore the "raw:" portion. Drop the year unless it differs from the current year.
- If a signal's ETA is "Unknown" or missing, do NOT invent or guess a date for it — even if the description mentions a holiday or named event. Either omit the date or use a phrase like "no confirmed date yet". Do NOT translate "Mother's Day", "the weekend", or similar phrases into specific calendar dates yourself.`;

    const firstRunRules = `FIRST-RUN RULES (this is the very first brief Conductor has written for ${userName}):
- Maximum 3 sentences
- Surface only the single most urgent or impressive signal from the near window
- Include the horizon signal if available
- End with one sentence hinting at depth, exactly: "Conductor is watching quite a bit more — it will surface what matters as it becomes relevant."
- Plain text only, no markdown
- Do not begin with date or header
- Personalize to ${userName}
- When referring to a future date, lift the day-and-date verbatim from the friendly string already provided in the ETA field. NEVER compute or infer a date.
- If a signal's ETA is "Unknown" or missing, do NOT invent or guess a date — even for holidays mentioned in the description.`;

    const userPrompt = `${layeredContext}\n\n${isFirstRun ? firstRunRules : baseRules}`;

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

    if (isFirstRun) {
      await redis.set(`household:${householdId}:firstRun`, "false");
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
    const segments = await tagBriefSegments(brief, tagSignals);

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
      household: householdId,
      user: userName,
      isFirstRun,
    });
  } catch (error) {
    console.error("Brief error:", error);
    return res.status(500).json({ error: "Failed to generate brief" });
  }
}
