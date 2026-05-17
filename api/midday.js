// Midday brief — 2-3 sentence afternoon status check. Reads what's
// resolved since the morning Takeoff, what's new since then, and what
// still needs attention before Clearance. Lighter than the full brief:
// one Claude Haiku call, no transparency / theRead / segment-tagging,
// no horizon picking, no first-run path. Mirrors the same post-
// generation sweep rules so the prose stays clean of the same offender
// patterns the morning brief is guarded against.

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const DAY_MS = 24 * 60 * 60 * 1000;
const CURRENT_MIDDAY_TTL_S = 4 * 60 * 60;

// ---------- helpers ----------

function safeJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return null; }
}

async function resolveHouseholdId(userId) {
  if (!userId) return "RangerOaks925";
  const hid = await redis.get(`user:${userId}:household`);
  return hid || "RangerOaks925";
}

async function loadUserName(userId) {
  if (!userId) return "there";
  try {
    const raw = await redis.get(`user:${userId}:profile`);
    const profile = typeof raw === "string" ? JSON.parse(raw) : raw;
    const name = profile?.name || profile?.firstName;
    if (typeof name === "string" && name.length > 0) {
      return name.split(/\s+/)[0];
    }
  } catch { /* ignored */ }
  return "there";
}

function isUrgent(s) {
  if (!s) return false;
  if (s.urgent === true) return true;
  const eta = s.eta ? Date.parse(s.eta) : NaN;
  if (isNaN(eta)) return false;
  return eta - Date.now() < 24 * 60 * 60 * 1000;
}

// ---------- sweep (mirrors brief.js — keep in manual sync) ----------

const SPELLED_NUMBERS = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty";
const QUANTIFIERS = "few|several|couple|handful|many|a few|a couple of";
const TIME_UNITS = "day|days|week|weeks|month|months|year|years";

const WINDOW_PHRASE_RE = new RegExp(
  "\\b(in|over|within|across|throughout)\\s+the\\s+(next|coming|upcoming)\\s+" +
  `(?:(${SPELLED_NUMBERS}|${QUANTIFIERS}|\\d+|a|an)\\s+(of\\s+)?)?` +
  `(${TIME_UNITS})\\b`,
  "gi"
);
const GAP_PHRASE_RE = new RegExp(
  `\\b(${SPELLED_NUMBERS}|\\d+|a|${QUANTIFIERS})` +
  `\\s+(${TIME_UNITS})` +
  "\\s+(later|after|ahead|earlier|afterward|subsequently|thereafter|from now|down the line|down the road|out)\\b",
  "gi"
);
const WEATHER_CLOSER_RE = /\b(clear skies( today| ahead)?|otherwise quiet weather|nothing weather-related|the weather'?s calm|the day is clear and warm|with the nice weather|given the calm forecast|weather looks fine)\b/gi;
const HYDRATION_NUDGE_RE = /\b(drink (?:more )?water (?:throughout|today|often|early|all day|regularly)|stay hydrated|hydrate (?:today|early|often|throughout|more|all day|regularly)|keep water (?:close|nearby|handy|on you)|the air (?:is|feels) (?:thick|heavy|sticky|soupy)|heavy air today|humid today|muggy today|thick air|sticky (?:out|today))\b/gi;
const POSITIVE_HEALTH_RE = /\b(your body (?:feels?|is|'s) strong|feeling strong|energy is good|in a strong window|strong recovery|recovery looks solid|good timing energy-wise|you're in a strong window)\b/gi;
const UNTIL_IN_RE = /\buntil in\b/gi;

function dedupeCi(arr) {
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function sweepMiddayForViolations(text) {
  if (!text || typeof text !== "string") return [];
  const violations = [];
  const checks = [
    ["window_phrase", WINDOW_PHRASE_RE],
    ["gap_phrase", GAP_PHRASE_RE],
    ["weather_closer", WEATHER_CLOSER_RE],
    ["hydration_nudge", HYDRATION_NUDGE_RE],
    ["positive_health", POSITIVE_HEALTH_RE],
    ["until_in_glue", UNTIL_IN_RE],
  ];
  for (const [rule, re] of checks) {
    re.lastIndex = 0;
    const m = text.match(re);
    if (m && m.length > 0) {
      violations.push({ rule, matches: dedupeCi(m) });
    }
  }
  return violations;
}

function buildRetryAddendum(violations) {
  const detail = violations
    .map((v) => `- ${v.rule}: ${v.matches.map((m) => `"${m}"`).join(", ")}`)
    .join("\n");
  return `

=== RETRY ATTEMPT ===
Your previous attempt contained these specific rule violations:
${detail}

Generate a new midday update from scratch. The same rules apply — the violations above MUST NOT appear in the new output. Do not acknowledge this retry in the output.`;
}

// ---------- handler ----------

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const userId = req.query?.userId;
  const householdId = await resolveHouseholdId(userId);
  const userName = await loadUserName(userId);

  // Cache check — same TTL pattern as currentTakeoff / currentClearance.
  // Push body and in-app prose stay aligned within the window.
  if (userId) {
    const cached = safeJson(await redis.get(`user:${userId}:currentMidday`));
    if (cached && typeof cached.midday === "string") {
      return res.status(200).json(cached);
    }
  }

  try {
    // Parallel pull: current signal list + morningBriefed hash.
    // morningBriefed was written by brief.js this morning with a 26h TTL —
    // each entry is JSON {status, state, ring} keyed by signalId. We
    // compare current signal state against that snapshot to bucket.
    const [rawSignals, morningBriefedRaw] = await Promise.all([
      redis.lrange(`household:${householdId}:signals`, 0, -1),
      redis.hgetall(`household:${householdId}:morningBriefed`),
    ]);

    const allSignals = (rawSignals || []).map(safeJson).filter(Boolean);
    const activeSignals = allSignals.filter(
      (s) => !s.state || s.state === "incoming" || s.state === "active"
    );

    const morningBriefedMap = (morningBriefedRaw && typeof morningBriefedRaw === "object")
      ? morningBriefedRaw
      : {};
    const morningBriefedIds = new Set(Object.keys(morningBriefedMap));

    // Bucketing relative to this morning's brief:
    //   resolvedSinceMorning — was in morningBriefed AND is now resolved
    //   stillInMotion        — was in morningBriefed AND is still active
    //   newSinceMorning      — currently active AND was NOT in morningBriefed
    //   urgentNow            — anything active with ETA <24h (regardless of bucket)
    const resolvedSinceMorning = [];
    const stillInMotion = [];
    for (const s of allSignals) {
      if (!morningBriefedIds.has(String(s.id))) continue;
      if (s.state === "resolved") resolvedSinceMorning.push(s);
      else if (!s.state || s.state === "incoming" || s.state === "active") stillInMotion.push(s);
    }
    const newSinceMorning = activeSignals.filter(
      (s) => !morningBriefedIds.has(String(s.id))
    );
    const urgentNow = activeSignals.filter(isUrgent);

    // Quiet path: nothing happened since morning AND nothing urgent. Skip
    // the Claude call entirely and ship a minimal honest line.
    if (
      resolvedSinceMorning.length === 0 &&
      newSinceMorning.length === 0 &&
      urgentNow.length === 0 &&
      stillInMotion.length === 0
    ) {
      const midday = "Nothing has shifted since this morning. The afternoon is yours.";
      const response = { midday, pulse: null, household: householdId, user: userName };
      if (userId) {
        await redis.set(`user:${userId}:currentMidday`, JSON.stringify(response), {
          ex: CURRENT_MIDDAY_TTL_S,
        });
      }
      return res.status(200).json(response);
    }

    const formatSignal = (s) => {
      const desc = s.description || "Unknown";
      const owner = s.userId && s.userId !== userId ? " [other member's]" : "";
      return `- ${desc}${owner}`;
    };

    const contextBlock = [
      `Today is ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}.`,
      ``,
      `RESOLVED SINCE MORNING (was in the morning brief, now rested):`,
      resolvedSinceMorning.length > 0 ? resolvedSinceMorning.map(formatSignal).join("\n") : "None",
      ``,
      `STILL IN MOTION (was in the morning brief, still incoming or active):`,
      stillInMotion.length > 0 ? stillInMotion.map(formatSignal).join("\n") : "None",
      ``,
      `NEW SINCE MORNING (arrived after the morning brief was written):`,
      newSinceMorning.length > 0 ? newSinceMorning.map(formatSignal).join("\n") : "None",
      ``,
      `URGENT NOW (ETA within 24 hours):`,
      urgentNow.length > 0 ? urgentNow.map(formatSignal).join("\n") : "None",
    ].join("\n");

    const baseUserPrompt = `${contextBlock}

Write a 2-3 sentence midday update for this household. Cover: what resolved since morning, what new signals arrived, what still needs attention before evening. Calm, direct voice. Never more than 3 sentences. This is a status check, not a full brief.

Rules:
- Maximum 3 sentences. Count them — a third sentence is the cap.
- Personalize to ${userName} naturally — use "you" not the name on every line.
- Plain text only, no markdown.
- Never quote raw temperatures, percentages, or health metrics — translate to qualitative phrases.
- Never use the banned closing phrasings (clear skies today, otherwise quiet weather, etc.).
- Never glue a lifted "(in N days)" phrase after "until" / "before" / "by".
- If nothing has resolved AND nothing new arrived AND nothing is urgent, say so briefly and stop.
- If something resolved cleanly, acknowledge it without ceremony.
- If nothing new arrived but several things are still pending, note that the morning's pace is holding.
- Never assistant-like ("Here's your midday update"). Just say what you see.`;

    const systemPrompt = `You are Conductor, a household intelligence layer. You write calm, trusted, personal midday status checks for ${userName}. Your voice is like a thought the reader was already having — never assistant-like, never listy, always prose.`;

    // Same generate-then-sweep retry loop pattern as brief.js: first
    // attempt = base prompt; on sweep violation, second attempt appends
    // the retry addendum naming offending phrases. Auth/billing errors
    // break the loop.
    const MAX_ATTEMPTS = 2;
    let midday = "";
    let attempts = 0;
    let lastViolations = [];
    while (attempts < MAX_ATTEMPTS) {
      attempts++;
      const userPrompt = lastViolations.length > 0
        ? baseUserPrompt + buildRetryAddendum(lastViolations)
        : baseUserPrompt;

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
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        }),
      });

      const data = await response.json();
      if (!response.ok || !data?.content?.[0]?.text) {
        console.error("[midday] Anthropic non-content response", {
          status: response.status,
          errorType: data?.error?.type,
          errorMessage: data?.error?.message,
          rawHead: JSON.stringify(data).slice(0, 400),
        });
        midday = data?.content?.[0]?.text || "";
        break;
      }
      midday = data.content[0].text;
      const violations = sweepMiddayForViolations(midday);
      if (violations.length === 0) {
        if (attempts > 1) console.log(`[midday] sweep clean on retry attempt ${attempts}`);
        lastViolations = [];
        break;
      }
      console.log(
        `[midday] sweep violations on attempt ${attempts}:`,
        violations.map((v) => `${v.rule}=${v.matches.length}`).join(" ")
      );
      lastViolations = violations;
    }
    if (lastViolations.length > 0) {
      console.log(
        `[midday] shipping after ${attempts} attempts with residual violations:`,
        lastViolations.map((v) => `${v.rule}[${v.matches.join("|")}]`).join(" ; ")
      );
    }

    const middayResponse = {
      midday,
      pulse: null, // synthesis layer not wired into midday yet — future work
      household: householdId,
      user: userName,
    };

    if (userId) {
      await redis.set(`user:${userId}:currentMidday`, JSON.stringify(middayResponse), {
        ex: CURRENT_MIDDAY_TTL_S,
      });
    }

    return res.status(200).json(middayResponse);
  } catch (error) {
    console.error("Midday error:", error);
    return res.status(500).json({ error: "Failed to generate midday brief" });
  }
}
