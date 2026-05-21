import { Redis } from "@upstash/redis";
import { loadHouseholdCalendar } from "./calendar-loader.js";
import { loadCamouflageRules, applyCamouflage, loadRecentCaughtMoments } from "./signals.js";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Same shape as brief.js's generateTransparency, with clearance-specific
// pool labels. Best-effort: returns null on any failure so the response
// still ships the prose without a transparency entry.
async function generateTransparency(brief, pools) {
  if (!brief) return null;

  // Pre-format signal lines with the authoritative day-count phrase the
  // main clearance brief lifts from. Prevents the transparency Claude
  // call from computing its own counts and producing values that
  // disagree with the brief prose.
  const briefList = (arr) => {
    if (!arr || arr.length === 0) return "(none)";
    return arr
      .map((s) => {
        const desc = s.description || "Unknown";
        const phrase = s.eta ? daysFromTodayPhrase(s.eta) : null;
        return phrase ? `- ${desc} (${phrase})` : `- ${desc}`;
      })
      .join("\n");
  };
  const eventList = (arr) => {
    if (!arr || arr.length === 0) return "(none)";
    return arr.map((e) => `- ${e.title || "Untitled"}`).join("\n");
  };
  const horizonPhrase =
    pools.horizon?.eta ? daysFromTodayPhrase(pools.horizon.eta) : null;
  const horizonLine = pools.horizon
    ? `- ${pools.horizon.description || "Unknown"}${horizonPhrase ? ` (${horizonPhrase})` : ""}`
    : "(none)";

  const prompt = `You just generated this evening brief: ${brief}

The signals you considered were (each carries an authoritative day-count phrase in parentheses — lift it verbatim, do NOT compute your own):
Rested today: ${briefList(pools.resolvedToday)}
Lapsed today: ${briefList(pools.expiredToday)}
Still in motion: ${briefList(pools.stillActive)}
Delayed: ${briefList(pools.carryingForward)}
Imminent deadlines: ${briefList(pools.urgentDeadlines)}
Near deadlines: ${briefList(pools.nearDeadlines)}
Last chance (still open from today): ${briefList(pools.lastChance)}
Tomorrow's calendar: ${eventList(pools.tomorrow)}
Horizon: ${horizonLine}

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
- Never assert what the user said, noted, mentioned, told you, indicated, expressed, confirmed, asked, or wrote. Describe only the signals present in the pool and how you weighed them. If you want to convey a user state, frame it as your own inference: "I inferred X" or "this reads like X" — never "you noted X".
- Never compute or estimate how many days away something is. Each signal line above carries an authoritative day-count phrase in parentheses ("(in 5 days)", "(today)", "(in 2 weeks)", "(yesterday)"); lift that phrase verbatim if you reference timing. Do NOT produce your own counts — the math is frequently wrong, and the authoritative phrase is provided so you don't have to compute.`;

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

  // Authoritative id → type map. The prompt asks Claude to copy the
  // signal's type field verbatim, but the model still sometimes
  // re-classifies based on brief phrasing. The validation pass below
  // forces signalType to match what's in the input pool, mirroring
  // brief.js's segmenter so type fidelity is guaranteed.
  const ALLOWED_SIGNAL_TYPES = new Set([
    "package", "delivery", "food", "grocery", "service",
    "reservation", "appointment", "travel", "deadline", "unknown",
  ]);
  const validIds = new Set(signals.map(s => String(s.id)));
  const idToType = new Map();
  for (const s of signals) {
    const t = ALLOWED_SIGNAL_TYPES.has(s.type) ? s.type : "unknown";
    idToType.set(String(s.id), t);
  }

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

signalType MUST be exactly one of: package, delivery, food, grocery, service, reservation, appointment, travel, deadline, unknown. Copy the 'type' field directly from the matched signal's entry in the Signals list — that field IS the canonical signalType. Do NOT re-classify based on how the brief phrases it (e.g. if the signal's type is "deadline" and the brief calls it a "subscription", use "deadline" — the list is authoritative). Use "unknown" only when the matched signal's type is not in the allowed list above.

MATCHING: use fuzzy/substring matching when the brief paraphrases a signal — descriptions in the Signals list are the canonical form, but the brief naturally shortens them. If the brief mentions a service, subscription, product, or vendor name that partially matches a signal's description, tag it. Examples:
- Brief "Health Tech Nerds subscription" → matches signal description "Health Tech Nerds subscription renewal"
- Brief "the Wind Policy" → matches signal description "Wind Policy on Homeowners insurance renewal"
The distinctive brand/product/policy noun is the anchor — full-string identity is NOT required.

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

    // Validation pass mirrors brief.js: drop signal segments with
    // unknown signalIds back to text, and coerce signalType to match
    // the canonical type from the input pool when the model drifts.
    let coercedCount = 0;
    let typeCoercedCount = 0;
    const validated = parsed.map((seg) => {
      if (
        seg &&
        seg.type === "signal" &&
        (seg.signalId == null || !validIds.has(String(seg.signalId)))
      ) {
        coercedCount++;
        return { type: "text", content: seg.content };
      }
      if (seg && seg.type === "signal" && seg.signalId) {
        const canonical = idToType.get(String(seg.signalId));
        if (canonical && seg.signalType !== canonical) {
          typeCoercedCount++;
          return { ...seg, signalType: canonical };
        }
      }
      return seg;
    });
    if (coercedCount > 0) {
      console.log(`[clearance] segmenter coerced ${coercedCount} segment(s) with invalid signalId to text`);
    }
    if (typeCoercedCount > 0) {
      console.log(`[clearance] segmenter coerced ${typeCoercedCount} segment(s) signalType to canonical pool type`);
    }

    return validated;
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

const DAY_MS_LOCAL = 24 * 60 * 60 * 1000;

// See brief.js parseEtaDeadline — same shape, kept inline so this
// module stays self-contained. Falls back to single-date parsing
// when no range separator is present.
function parseEtaDeadline(value) {
  if (!value || typeof value !== "string") return parseDateLoose(value);
  const direct = parseDateLoose(value);
  if (direct) return direct;
  const parts = value.split(/\s+(?:to|through|thru|–|—|-)\s+/i);
  if (parts.length >= 2) {
    const a = parseDateLoose(parts[0]);
    const b = parseDateLoose(parts[parts.length - 1]);
    if (a && b) return a.getTime() > b.getTime() ? a : b;
    if (b) return b;
    if (a) return a;
  }
  return null;
}

function daysFromTodayPhrase(value) {
  const d = parseEtaDeadline(value);
  if (!d) return null;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);
  const n = Math.round((target.getTime() - startOfToday.getTime()) / DAY_MS_LOCAL);
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n > 0) {
    // Clean multiples of 7 emit a weeks-form so the model lifts
    // "in 2 weeks" rather than paraphrasing "in 14 days" itself.
    if (n >= 7 && n % 7 === 0) {
      const weeks = n / 7;
      return weeks === 1 ? "in 1 week" : `in ${weeks} weeks`;
    }
    return `in ${n} days`;
  }
  if (n === -1) return "yesterday";
  return `already passed ${-n} days ago`;
}

function etaWithFriendly(raw) {
  if (!raw) return "Unknown";
  const friendly = friendlyDate(raw);
  if (!friendly) return raw;
  const phrase = daysFromTodayPhrase(raw);
  return phrase ? `${friendly} (${phrase}) (raw: ${raw})` : `${friendly} (raw: ${raw})`;
}

// Week in Review — Sunday-evening reflection paragraph. Reads the
// household memory log (signal lifecycle log written by signals.js on
// every PATCH and by loadSignals on auto-expiry), buckets the last 7
// days, computes a current streak, and asks Claude for one warm
// paragraph. Returns null on non-Sunday or any failure — the response
// always carries the field so the mobile renderer can decide whether
// to render the section.
async function loadHouseholdName(householdId) {
  try {
    const raw = await redis.get(`household:${householdId}:profile`);
    const profile = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
    return profile?.householdName || null;
  } catch { return null; }
}

async function generateWeekInReview(householdId, householdName) {
  try {
    // Sunday detection uses the household's local timezone. Per-household
    // TZ resolution comes from location.js; falls back to ET when
    // unavailable so older households without lat/lon keep working.
    let tz = "America/New_York";
    try {
      const { getHouseholdTimezone } = await import("./location.js");
      tz = (await getHouseholdTimezone(householdId)) || "America/New_York";
    } catch { /* fall back */ }
    const localWeekday = new Date().toLocaleString("en-US", {
      timeZone: tz,
      weekday: "short",
    });
    if (localWeekday !== "Sun") return null;

    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - SEVEN_DAYS_MS;
    const rawMemory = await redis.lrange(`household:${householdId}:memory`, 0, -1);
    const entries = (rawMemory || [])
      .map((v) => { try { return JSON.parse(v); } catch { return null; } })
      .filter(Boolean)
      .filter((e) => {
        const ms = Date.parse(e.actionAt || "");
        return !isNaN(ms) && ms >= cutoff;
      });

    // Bucket by action. "resolved" = rested; "expired" = lapsed; "held"
    // means active — counts as carriedForward in week-level framing.
    let rested = 0, lapsed = 0, carriedForward = 0, deadlinesCaught = 0;
    for (const e of entries) {
      if (e.action === "resolved") {
        rested++;
        if (e.type === "deadline") deadlinesCaught++;
      } else if (e.action === "expired") {
        lapsed++;
      } else if (e.action === "held") {
        carriedForward++;
      }
    }

    // Streak: consecutive days ending today with at least one resolved.
    // Bucket entries by local YYYY-MM-DD and walk back from today.
    const restedDays = new Set();
    for (const e of entries) {
      if (e.action !== "resolved") continue;
      const ms = Date.parse(e.actionAt || "");
      if (isNaN(ms)) continue;
      const d = new Date(ms);
      const key = d.toLocaleDateString("en-US", {
        timeZone: "America/New_York",
        year: "numeric", month: "2-digit", day: "numeric",
      });
      restedDays.add(key);
    }
    let streak = 0;
    for (let i = 0; i < 7; i++) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const key = d.toLocaleDateString("en-US", {
        timeZone: "America/New_York",
        year: "numeric", month: "2-digit", day: "numeric",
      });
      if (restedDays.has(key)) streak++;
      else break;
    }

    // Persisted streakData lives at household:{id}:streakData and is
    // updated by signals.js on every state→resolved transition. We
    // surface its currentStreak alongside the in-memory streak above
    // since the persisted counter captures cross-week continuity and
    // hits the 14/30-day milestones the memory-window scan can't.
    let persistedStreak = 0;
    try {
      const rawStreak = await redis.get(`household:${householdId}:streakData`);
      const data = typeof rawStreak === "string" ? JSON.parse(rawStreak) : rawStreak;
      persistedStreak = (data && Number(data.currentStreak)) || 0;
    } catch {
      // best-effort; fall back to memory-window streak
    }
    const streakForPrompt = Math.max(streak, persistedStreak);
    let streakMilestone = null;
    if (streakForPrompt >= 30) {
      streakMilestone =
        "A full month. Conductor has been watching and you've been handling things. That's the whole game.";
    } else if (streakForPrompt >= 14) {
      streakMilestone =
        "Two weeks without anything slipping through. The household is running well.";
    } else if (streakForPrompt >= 7) {
      streakMilestone = "Seven days running — nothing has slipped this week.";
    }

    // No memory at all → no review. A blank week is a real outcome but
    // the paragraph would be hollow; the section quietly stays absent.
    if (rested === 0 && lapsed === 0 && carriedForward === 0) return null;

    // Caught moments — pick the single most-significant one of the
    // week (smallest daysBeforeExpiry = closest call). One mention max
    // in the Week in Review so the paragraph doesn't read like a
    // highlight reel.
    const recentCaughtMoments = await loadRecentCaughtMoments(householdId, 7);
    let topCaught = null;
    if (recentCaughtMoments.length > 0) {
      topCaught = recentCaughtMoments
        .slice()
        .sort((a, b) => (a.daysBeforeExpiry ?? 99) - (b.daysBeforeExpiry ?? 99))[0];
    }

    // Week's emotional context — load any high-intensity signals that
    // were active in the past week. The signals list carries the
    // emotionalValence/emotionalIntensity fields that the brief layer
    // uses; we read them here so the review's tone matches what the
    // household actually went through. Best-effort: a redis hiccup
    // leaves the review with no emotional calibration, which is the
    // pre-existing baseline.
    let emotionalContextBlock = "";
    try {
      const rawSignals = await redis.lrange(`household:${householdId}:signals`, 0, 199);
      const recentSignals = (rawSignals || [])
        .map((v) => { try { return JSON.parse(v); } catch { return null; } })
        .filter(Boolean);
      const weekHigh = recentSignals.filter((s) => {
        if (s?.emotionalIntensity !== "high") return false;
        const ts = Date.parse(s?.createdAt || s?.lastUpdate || "");
        return !isNaN(ts) && ts >= cutoff;
      });
      if (weekHigh.length > 0) {
        const lines = weekHigh.slice(0, 6).map((s) => {
          const v = s.emotionalValence || "neutral";
          const d = (s.description || "(unspecified)").slice(0, 140);
          return `${v}: ${d}`;
        });
        const griefThisWeek = weekHigh.some((s) => s.emotionalValence === "grief");
        const milestoneThisWeek = weekHigh.some((s) => s.emotionalValence === "joyful");

        const calibration = griefThisWeek
          ? `If grief signals were active this week: acknowledge the weight first. Keep the review brief. "Hard week." is a complete and valid opening sentence.`
          : milestoneThisWeek
          ? `If milestone signals were active: lead with the milestone. Everything else is secondary. The household kept running while something important happened.`
          : `Steady, honest, specific. This is what good looks like.`;

        emotionalContextBlock = `\nWEEK'S EMOTIONAL CONTEXT:\n${lines.join("\n")}\n\n${calibration}\n`;
      }
    } catch (err) {
      console.warn("[weekInReview] emotional context load failed:", err?.message || err);
    }

    const householdRef = householdName ? `${householdName}` : "this household";
    const prompt = `Write a warm, honest one-paragraph Week in Review for ${householdRef}. Cover:
- How many signals were handled this week (${rested} rested, ${carriedForward} carried forward, ${lapsed} lapsed)
- Any deadlines caught before they slipped (${deadlinesCaught} deadlines caught this week)
- The streak if active: ${streakMilestone ? streakMilestone : streakForPrompt >= 2 ? `${streakForPrompt} days running — nothing has slipped` : "(no notable streak this week)"}
- One honest observation about how the week went
- If the week was genuinely good: acknowledge it warmly
- If the week was hard: acknowledge it without judgment
- If there's something funny or ironic about the week: let it land with a light touch
${topCaught ? `- Most significant caught moment this week: "${topCaught.description}"${topCaught.sender ? ` from ${topCaught.sender}` : ""} — handled with ${topCaught.daysBeforeExpiry} day(s) to spare. Include this as one warm sentence in the review.` : ""}

Rules: warm but not effusive. Honest. Maximum 4 sentences. Never clinical. This should feel like something worth reading. Plain text, no markdown. Never quote the raw numbers as bare digits in a clinical way ("${rested} signals rested this week" is fine; "${rested}/${rested + carriedForward + lapsed} resolution rate" is not). Refer to the household in second person — "you" / "your".${emotionalContextBlock}`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 350,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.error("[weekInReview] Anthropic error", response.status, errText.slice(0, 200));
      return null;
    }
    const data = await response.json();
    const text = data?.content?.[0]?.text?.trim();
    if (!text) return null;

    // Conductor auto-post — drop the Week in Review's first sentence
    // into the Crew Channel exactly once per week. weeklyReviewAck
    // key keyed by the Monday-anchor ISO so a re-run on the same
    // Sunday doesn't duplicate.
    try {
      const ackKey = `household:${householdId}:weeklyReviewChannelAck:${cutoff}`;
      const already = await redis.get(ackKey).catch(() => null);
      if (!already) {
        const firstSentence = (text.split(/(?<=[.!?])\s+/)[0] || "").trim();
        if (firstSentence) {
          const { postConductorMessage } = await import("./channel.js");
          await postConductorMessage(householdId, `📊 Week in Review: ${firstSentence}`);
          await redis.set(ackKey, "1", { ex: 7 * 24 * 60 * 60 }).catch(() => null);
        }
      }
    } catch (err) {
      console.warn("[channel] week-in-review post failed:", err?.message || err);
    }

    return text;
  } catch (err) {
    console.error("Week in Review failed:", err?.message || err);
    return null;
  }
}

// Month in Review — fires only on the last day of the month in ET.
// Same Haiku pattern as Week in Review but spans the whole month
// (from day 1 in ET). Returns null on any non-last-day or on empty
// memory months so the mobile renderer can hide the section.
// Evening cards — appear at the bottom of Clearance only. Each card is
// best-effort: a single card failure returns null and the others ship.
// The mobile renderer filters nulls so the visible stack is exactly
// what we have to say tonight, no skeleton rows.
//
// Cards:
//   1. quick_actions  — sub-2-minute resolvable signals
//   2. opportunity    — hobby-tied invitation (skip when no hobbies set)
//   3. suppressed     — items held back from brief (over-suppressed or overdue)
//   4. observation    — one warm sentence about the household, Haiku-generated
async function generateEveningCards(householdId, context) {
  const { signals, allDeadlines } = context;
  const cards = [];

  // Card 1: quick_actions — signals the user could clear in under 2 minutes.
  // Heuristic: any signal with a URL/confirmationNumber, or any signal not
  // marked recurring (those can be snoozed without consequence). Top 3.
  try {
    const candidates = (signals || [])
      .filter((s) => !s.state || s.state === "incoming" || s.state === "active")
      .filter((s) => s.confirmationNumber || s.url || s.recurring === false || !s.recurring)
      .slice(0, 3);
    if (candidates.length > 0) {
      cards.push({
        type: "quick_actions",
        items: candidates.map((s) => ({
          signalId: s.id,
          description: s.description || "Unknown signal",
          action: s.confirmationNumber ? "Confirm" : s.url ? "Open" : "Snooze",
        })),
      });
    }
  } catch (err) {
    console.warn("[eveningCards] quick_actions failed:", err?.message || err);
  }

  // Card 2: opportunity — gated on hobbies. Falls through to surf/marine
  // when 'water' is selected + coords are available; otherwise picks a
  // hobby keyword and surfaces a generic invitation phrasing. Skip
  // entirely when no hobbies are set.
  try {
    const rawHobbies = await redis.get(`household:${householdId}:hobbies`);
    const parsed = rawHobbies
      ? (typeof rawHobbies === "string" ? JSON.parse(rawHobbies) : rawHobbies)
      : null;
    const hobbies = Array.isArray(parsed?.values) ? parsed.values : [];
    if (hobbies.length > 0) {
      let opportunity = null;
      if (hobbies.includes("water") && context.location?.lat && context.location?.lon) {
        try {
          const { getSurfConditions } = await import("./hobbies.js");
          const surf = await getSurfConditions(
            context.location.lat,
            context.location.lon,
            hobbies
          );
          if (surf && (surf.conditions === "excellent" || surf.conditions === "good")) {
            const wh = typeof surf.waveHeight === "number"
              ? `${surf.waveHeight.toFixed(1)}ft seas`
              : "decent surf";
            const wind = surf.windDirection && surf.windSpeed
              ? `, ${surf.windDirection} ${Math.round(surf.windSpeed)}mph wind`
              : "";
            opportunity = {
              type: "opportunity",
              title: "TONIGHT / THIS WEEKEND",
              description: `${surf.conditions === "excellent" ? "Looks excellent for the water" : "Conditions are good for the water"} — ${wh}${wind}. Worth keeping open.`,
              ctaText: "Got it",
              ctaAction: "ack",
            };
          }
        } catch { /* fall through */ }
      }
      // Generic hobby fallback when surf-specific didn't trigger. Picks
      // the first hobby as an anchor for a soft invitation; the brief's
      // synthesis already handles the more-tailored "what does the week
      // offer" framing.
      if (!opportunity) {
        const lead = hobbies[0];
        const phrases = {
          music: "Worth scanning the city calendar this weekend — something usually surfaces.",
          food: "Resy and Tock are quiet right now — a good week to lock in a Saturday spot.",
          golf: "Tee times for the weekend are still open at most courses around the area.",
          fitness: "A studio class block this week could be worth booking ahead.",
          art: "Worth checking what's hanging at the local galleries this weekend.",
          travel: "Flight prices for the next month-out window tend to drop midweek.",
          sports: "Take a look at this weekend's local games — tickets ease up after Friday.",
          outdoors: "Trails should be in good shape this weekend — worth keeping a window open.",
          film: "A few new releases land this weekend — a Friday night could pay for itself.",
          wine: "Tasting events around town pick up on weekends — easy to slot one in.",
          cycling: "Routes look clear for a Saturday ride if the weather holds.",
          books: "A quiet hour with the book that's been waiting on the shelf isn't a bad use of tonight.",
          gaming: "An evening on the couch with whatever's in the queue counts as a real choice.",
          wellness: "An early bedtime or a long walk after dinner — both count.",
        };
        const text = phrases[lead] || "There's room in the week to make time for what you actually enjoy.";
        opportunity = {
          type: "opportunity",
          title: "TONIGHT / THIS WEEKEND",
          description: text,
          ctaText: "Got it",
          ctaAction: "ack",
        };
      }
      if (opportunity) cards.push(opportunity);
    }
  } catch (err) {
    console.warn("[eveningCards] opportunity failed:", err?.message || err);
  }

  // Card 3: suppressed — signals briefCount >= 5 (Conductor surfaced
  // it five mornings and the user hasn't acted, so by definition it
  // got de-prioritized in subsequent briefs) + vault items 60+ days
  // past renewal. Top 3.
  try {
    const items = [];
    for (const s of (signals || [])) {
      if (typeof s.briefCount === "number" && s.briefCount >= 5) {
        items.push({
          description: s.description || "Unknown signal",
          daysSuppressed: s.briefCount,
          action: "ack",
        });
      }
      if (items.length >= 3) break;
    }
    if (items.length < 3) {
      const now = Date.now();
      for (const d of (allDeadlines || [])) {
        const renew = d.renewalDate ? Date.parse(d.renewalDate) : NaN;
        if (!isNaN(renew) && now - renew > 60 * 24 * 60 * 60 * 1000) {
          items.push({
            description: d.description || "Overdue deadline",
            daysSuppressed: Math.floor((now - renew) / (24 * 60 * 60 * 1000)),
            action: "ack",
          });
          if (items.length >= 3) break;
        }
      }
    }
    if (items.length > 0) {
      cards.push({ type: "suppressed", items });
    }
  } catch (err) {
    console.warn("[eveningCards] suppressed failed:", err?.message || err);
  }

  // Card 4: observation — one honest line about the household.
  // Generated via Claude Haiku. The prompt is intentionally short so
  // a 200-token reply is the upper bound.
  try {
    const streakRaw = await redis.get(`household:${householdId}:streakData`);
    const streak = streakRaw
      ? (typeof streakRaw === "string" ? JSON.parse(streakRaw) : streakRaw)
      : null;
    const observationPrompt = `Write ONE warm, honest observation about a household based on these stats. Plain text, one sentence, no preamble, no markdown, never effusive. If nothing stands out, observe something quiet about the day.

Current streak: ${streak?.currentStreak ?? 0} days
Peak streak: ${streak?.peakStreak ?? 0} days
Active signals: ${(signals || []).length}
Open deadlines: ${(allDeadlines || []).length}`;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 120,
          messages: [{ role: "user", content: observationPrompt }],
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        const text = data?.content?.[0]?.text?.trim() || "";
        if (text) {
          cards.push({
            type: "observation",
            text: text.replace(/^["'“”]+|["'“”]+$/g, "").trim(),
          });
        }
      }
    }
  } catch (err) {
    console.warn("[eveningCards] observation failed:", err?.message || err);
  }

  // Card 5: joke_offer — the in-between zone where the evening has
  // been hard but not catastrophic. Same eligibility rules as
  // brief.js (medium-intensity stress, no high-intensity stress or
  // grief, no active alert) and the same once-per-day daily key so
  // the user isn't offered both a morning brief joke and an evening
  // card joke on the same day.
  try {
    const signals = context.signals || [];
    const mediumStress = signals.find(
      (s) => s?.emotionalIntensity === "medium" && s?.emotionalValence === "stressful"
    );
    const highGrief = signals.some(
      (s) => s?.emotionalIntensity === "high" && s?.emotionalValence === "grief"
    );
    const highStress = signals.some(
      (s) => s?.emotionalIntensity === "high" && s?.emotionalValence === "stressful"
    );
    const hasActiveAlert = !!(await redis.get(`household:${householdId}:activeAlert`).catch(() => null));
    // Clearance fires in the evening — we don't have synthesisState
    // here, so the heuristic is signal count instead of signalLoad
    // bucket. Anything north of 4 active signals at end-of-day is
    // "the load is dragging" in this surface.
    const loadHeavyish = signals.length >= 4;

    const eligible = !!mediumStress && !highGrief && !highStress && !hasActiveAlert && loadHeavyish;

    if (eligible) {
      const dailyKey = `household:${householdId}:jokeOfferedToday`;
      const alreadyOffered = await redis.get(dailyKey).catch(() => null);
      if (!alreadyOffered) {
        const offerPrompt = `The household is having a stressful but not catastrophic evening.
Active signals: ${signals.length}
The day is closing down.

Write one understated offer line that gently offers a laugh.
Don't say 'cheer up' or anything patronizing.
The tone is: a trusted friend who noticed you're tired and has something that might help.
Maximum 12 words. End with an em dash — The Conductor will show the joke on tap.

Examples of the right tone:
'Heavy day. The Conductor has one more thing if you need it —'
'A lot in motion. Something lighter, if you want it —'

Return only the offer line.`;
        try {
          const apiKey = process.env.ANTHROPIC_API_KEY;
          if (apiKey) {
            const resp = await fetch("https://api.anthropic.com/v1/messages", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
              },
              body: JSON.stringify({
                model: "claude-haiku-4-5-20251001",
                max_tokens: 100,
                messages: [{ role: "user", content: offerPrompt }],
              }),
            });
            if (resp.ok) {
              const data = await resp.json();
              const text = (data?.content?.[0]?.text || "").trim().replace(/^["'“”]+|["'“”]+$/g, "");
              if (text && text.length <= 120) {
                cards.push({ type: "joke_offer", offer: text });
                // Set midnight TTL daily key so a later/repeat call
                // doesn't double up.
                const now = new Date();
                const nextMidnight = new Date(now);
                nextMidnight.setUTCHours(24, 0, 0, 0);
                const ttlSec = Math.max(60, Math.floor((nextMidnight.getTime() - now.getTime()) / 1000));
                await redis.set(dailyKey, "1", { ex: ttlSec }).catch(() => null);
              }
            }
          }
        } catch (err) {
          console.warn("[eveningCards] joke_offer haiku failed:", err?.message || err);
        }
      }
    }
  } catch (err) {
    console.warn("[eveningCards] joke_offer eligibility failed:", err?.message || err);
  }

  return cards;
}

async function generateMonthInReview(householdId) {
  try {
    // Last-day detection in America/New_York: a day is the last of
    // the month iff (today + 1 day) is the 1st of any month in the
    // same timezone.
    const tomorrowET = new Date(Date.now() + 24 * 60 * 60 * 1000)
      .toLocaleString("en-US", {
        timeZone: "America/New_York",
        day: "2-digit",
      });
    if (tomorrowET !== "01") return null;

    // Window: the 1st of the current month (ET) through now.
    const todayET = new Date().toLocaleString("en-US", {
      timeZone: "America/New_York",
      year: "numeric", month: "2-digit", day: "2-digit",
    });
    const [m, , y] = todayET.split("/"); // "MM/DD/YYYY"
    const monthStartMs = Date.parse(`${y}-${m}-01T00:00:00-04:00`);
    if (isNaN(monthStartMs)) return null;

    const [rawMemory, rawCaught, rawStreak] = await Promise.all([
      redis.lrange(`household:${householdId}:memory`, 0, -1),
      redis.lrange(`household:${householdId}:caughtMoments`, 0, -1).catch(() => []),
      redis.get(`household:${householdId}:streakData`).catch(() => null),
    ]);

    const entries = (rawMemory || [])
      .map((r) => { try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; } })
      .filter(Boolean)
      .filter((e) => {
        const ms = Date.parse(e.actionAt || "");
        return !isNaN(ms) && ms >= monthStartMs;
      });

    let rested = 0;
    let lapsed = 0;
    let deadlinesCaught = 0;
    let carriedForward = 0;
    let crewEvents = 0;
    let vaultHandled = 0;
    for (const e of entries) {
      if (e.action === "resolved") rested++;
      if (e.action === "expired" || e.action === "lapsed") lapsed++;
      if (e.action === "held") carriedForward++;
      if (e.action === "resolved" && e.type === "deadline") {
        deadlinesCaught++;
        vaultHandled++;
      }
      if (e.type === "appointment" || e.type === "celebration") crewEvents++;
    }
    if (rested === 0 && lapsed === 0 && carriedForward === 0) return null;

    const caught = (rawCaught || [])
      .map((r) => { try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; } })
      .filter(Boolean)
      .filter((c) => {
        const ms = Date.parse(c.resolvedAt || "");
        return !isNaN(ms) && ms >= monthStartMs;
      });
    const topCaught = caught.length > 0
      ? caught.slice().sort((a, b) => (a.daysBeforeExpiry ?? 99) - (b.daysBeforeExpiry ?? 99))[0]
      : null;

    const streak = (() => { try { return typeof rawStreak === "string" ? JSON.parse(rawStreak) : rawStreak; } catch { return null; } })();
    const longest = (streak && streak.longestStreak) || 0;

    const monthLabel = new Date(monthStartMs).toLocaleString("en-US", {
      timeZone: "America/New_York",
      month: "long", year: "numeric",
    });

    const prompt = `Write a warm, honest Month in Review for this household covering ${monthLabel}.

Data:
- Signals rested this month: ${rested}
- Signals that lapsed: ${lapsed}
- Signals carried forward (held): ${carriedForward}
- Deadlines caught before slipping: ${deadlinesCaught}
- Longest streak this month: ${longest} days
- Crew events / appointments touched: ${crewEvents}
- Vault items handled: ${vaultHandled}
${topCaught ? `- Most significant caught moment: "${topCaught.description}" — ${topCaught.daysBeforeExpiry} day(s) to spare` : ""}

Cover: what the household handled, any patterns you noticed, what was caught before it slipped, how the streak looked. If there's something genuinely funny or ironic about the month, let it land. Maximum 5 sentences. Warm, not clinical. This should feel earned. Plain text, no markdown. Refer to the household in second person ("you" / "your"). Never quote raw ratios or percentages.`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.error("[monthInReview] Anthropic error", response.status, errText.slice(0, 200));
      return null;
    }
    const data = await response.json();
    const text = data?.content?.[0]?.text?.trim();
    if (!text) return null;
    return text;
  } catch (err) {
    console.error("Month in Review failed:", err?.message || err);
    return null;
  }
}

// Year in Review — fires only on December 31 in ET. Uses Sonnet
// (not Haiku) because this is the most important brief Conductor
// writes all year. Persists at household:{id}:yearInReview:{year}
// with no TTL so historical years remain accessible forever.
//
// Returns null on any non-Dec-31 day; clearance.js threads the
// field through so the mobile renderer can hide it gracefully on
// every other day.
async function generateYearInReview(householdId) {
  try {
    // ET date guard. Dec 31 only.
    const etParts = new Date()
      .toLocaleString("en-US", {
        timeZone: "America/New_York",
        month: "2-digit", day: "2-digit", year: "numeric",
      })
      .split("/");
    if (etParts.length < 3) return null;
    const [mm, dd, yyyy] = etParts;
    if (mm !== "12" || dd !== "31") return null;
    const year = parseInt(yyyy, 10);
    if (!Number.isFinite(year)) return null;

    // Already generated for this year? Return the persisted record
    // so the cron firing twice (clearance + edge re-evaluation) is
    // idempotent. The Sonnet call is expensive; we don't want it
    // running again once we have a result.
    const persisted = await redis.get(`household:${householdId}:yearInReview:${year}`);
    if (typeof persisted === "string" && persisted.length > 0) {
      return persisted;
    }

    const yearStart = Date.parse(`${year}-01-01T00:00:00-05:00`);
    const yearEnd = Date.parse(`${year}-12-31T23:59:59-05:00`);
    if (isNaN(yearStart) || isNaN(yearEnd)) return null;

    const [rawMemory, rawCaught, rawStreak, rawTransitions, rawVault] = await Promise.all([
      redis.lrange(`household:${householdId}:memory`, 0, -1).catch(() => []),
      redis.lrange(`household:${householdId}:caughtMoments`, 0, -1).catch(() => []),
      redis.get(`household:${householdId}:streakData`).catch(() => null),
      redis.lrange(`household:${householdId}:transitions`, 0, -1).catch(() => []),
      redis.lrange(`household:${householdId}:vault`, 0, -1).catch(() => []),
    ]);

    const memory = (rawMemory || [])
      .map((r) => { try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; } })
      .filter(Boolean)
      .filter((e) => {
        const ms = Date.parse(e.actionAt || "");
        return !isNaN(ms) && ms >= yearStart && ms <= yearEnd;
      });
    const caught = (rawCaught || [])
      .map((r) => { try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; } })
      .filter(Boolean)
      .filter((c) => {
        const ms = Date.parse(c.resolvedAt || "");
        return !isNaN(ms) && ms >= yearStart && ms <= yearEnd;
      });
    const transitions = (rawTransitions || [])
      .map((r) => { try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; } })
      .filter(Boolean)
      .filter((t) => {
        const ms = Date.parse(t.createdAt || t.transitionDate || "");
        return !isNaN(ms) && ms >= yearStart && ms <= yearEnd;
      });
    const vaultHandled = (rawVault || [])
      .map((r) => { try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; } })
      .filter(Boolean)
      .filter((v) => {
        if (!v.handled && !v.handledAt) return false;
        const ms = Date.parse(v.handledAt || "");
        return !isNaN(ms) ? ms >= yearStart && ms <= yearEnd : true;
      }).length;

    let totalRested = 0;
    let totalLapsed = 0;
    let deadlinesCaught = 0;
    let crewCount = 0;
    const monthBuckets = new Map();
    for (const e of memory) {
      if (e.action === "resolved") totalRested++;
      if (e.action === "expired" || e.action === "lapsed") totalLapsed++;
      if (e.action === "resolved" && e.type === "deadline") deadlinesCaught++;
      if (e.type === "appointment" || e.type === "celebration") crewCount++;
      const m = new Date(Date.parse(e.actionAt || ""))
        .toLocaleString("en-US", { timeZone: "America/New_York", month: "long" });
      monthBuckets.set(m, (monthBuckets.get(m) || 0) + (e.action === "resolved" ? 1 : 0));
    }
    if (totalRested === 0 && totalLapsed === 0) return null;

    let mostActiveMonth = null;
    let quietestMonth = null;
    if (monthBuckets.size > 0) {
      const sorted = [...monthBuckets.entries()].sort((a, b) => b[1] - a[1]);
      mostActiveMonth = sorted[0]?.[0] || null;
      quietestMonth = sorted[sorted.length - 1]?.[0] || null;
    }

    const topCaught = caught.length > 0
      ? caught.slice().sort((a, b) => (a.daysBeforeExpiry ?? 99) - (b.daysBeforeExpiry ?? 99))[0]
      : null;
    const streak = (() => { try { return typeof rawStreak === "string" ? JSON.parse(rawStreak) : rawStreak; } catch { return null; } })();
    const longestStreak = (streak && streak.longestStreak) || 0;

    const transitionsSummary = transitions
      .map((t) => t.transitionType)
      .filter(Boolean)
      .map((t) => t.replace(/_/g, " "))
      .join(", ");

    const prompt = `Write a Year in Review for this household. This is the most important brief Conductor generates all year.

Data from ${year}:
- Signals handled: ${totalRested} rested, ${totalLapsed} lapsed
- Deadlines caught before slipping: ${deadlinesCaught}
${topCaught ? `- Closest call: "${topCaught.description}" — caught ${topCaught.daysBeforeExpiry} day(s) before it lapsed` : ""}
- Longest streak: ${longestStreak} consecutive days
- Vault items handled: ${vaultHandled}
${transitionsSummary ? `- Life transitions: ${transitionsSummary}` : ""}
${mostActiveMonth ? `- Most active month: ${mostActiveMonth}` : ""}
${quietestMonth && quietestMonth !== mostActiveMonth ? `- Quietest month: ${quietestMonth}` : ""}
- Crew events touched: ${crewCount}

Write 4-6 sentences. Warm, reflective, honest. Acknowledge what the household accomplished. Call out the most significant caught moment specifically if present. If the streak is impressive, honor it. If there were hard months, acknowledge them without dwelling. End with one sentence looking ahead.

This should feel like something worth saving. Like a letter from someone who was paying attention all year. Never clinical. Never a list. Pure prose. Refer to the household in second person ("you" / "your"). Plain text, no markdown.`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        // Sonnet — full reasoning intelligence for the most important
        // brief of the year. The cost is one-time per year per
        // household, justified by the moment.
        model: "claude-sonnet-4-6",
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.error("[yearInReview] Anthropic error", response.status, errText.slice(0, 200));
      return null;
    }
    const data = await response.json();
    const text = data?.content?.[0]?.text?.trim();
    if (!text) return null;

    // Persist permanently — no TTL. Historical years remain
    // retrievable via GET ?type=yearInReview&year=YYYY.
    await redis.set(`household:${householdId}:yearInReview:${year}`, text);
    return text;
  } catch (err) {
    console.error("Year in Review failed:", err?.message || err);
    return null;
  }
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

    // Cache: notify.js calls /api/clearance to extract the push-body
    // first sentence; the user may then open the app within minutes
    // expecting the same brief. The success path writes the response
    // to user:{userId}:currentClearance with a 6-hour TTL so the next
    // call for the same user returns the cached response verbatim,
    // keeping push body and app brief in sync.
    const CURRENT_CLEARANCE_TTL_S = 6 * 60 * 60;
    if (userId) {
      const cached = safeJson(await redis.get(`user:${userId}:currentClearance`));
      if (cached && typeof cached.brief === "string") {
        return res.status(200).json(cached);
      }
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

    // Camouflage filter — same guarantee as brief.js. Every downstream
    // pool (resolvedToday, expiredToday, stillActive, carryingForward,
    // lastChance) reads from `signals`, so a single filter pass here
    // keeps camouflaged entries out of the evening brief entirely.
    const camouflageRules = await loadCamouflageRules(householdId);
    const signals = applyCamouflage(
      (rawSignals || []).map(s => typeof s === "string" ? JSON.parse(s) : s),
      camouflageRules
    );
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

    // Caught moments — last 7 days of close-call resolutions. Formatted
    // for the prompt; if any are within 72h of the deadline AND happened
    // within today, the clearance brief acknowledges them warmly at the
    // end. Conservative format so the model has the specifics but isn't
    // tempted to embellish.
    const recentCaughtMoments = await loadRecentCaughtMoments(householdId, 7);
    const caughtMomentsSummary = recentCaughtMoments.length > 0
      ? recentCaughtMoments
          .map((cm) => {
            const dayBeforeStr = cm.daysBeforeExpiry === 0
              ? "same day"
              : `${cm.daysBeforeExpiry}d before deadline`;
            return `- ${cm.description}${cm.sender ? ` (${cm.sender})` : ""} — ${dayBeforeStr}, resolved ${cm.resolvedAt}`;
          })
          .join("\n")
      : "None";

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

CAUGHT MOMENTS THIS WEEK (acknowledge warmly at end of clearance if a genuinely close call resolved today, maximum 1 sentence):
${caughtMomentsSummary}

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
- 3-5 sentences maximum. Count every sentence aloud as you write — when you reach 5, STOP and end the brief, even if a layer is still unexplored. The cap is hard; a "Looking ahead" closing sentence still counts.
- Never mention the same signal twice in one brief. Each signal gets exactly one mention, in the layer where it most belongs. The horizon-closer phrases attach to that one mention — they do not warrant a second sentence about the same signal.
- If you find yourself writing a second sentence about a signal you've already mentioned, DELETE the second sentence and stop. The horizon-closer phrases are NOT a reason to mention a signal again — fold them into the original sentence if they apply, or omit them entirely if they don't. "Looking ahead" / "Looking further out" / "Beyond that" sentences are forbidden when their subject already appeared earlier in the brief.
- The horizon-closer phrases (worth watching / Conductor has its eye on this / on the radar / watching for it / we'll flag it when it matters) apply ONLY to signals MORE THAN 14 DAYS out. A signal at 13 days, 7 days, or less is in the near window — it gets a date or day-count reference, NOT a horizon closer.
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
- Caught moments: when the CAUGHT MOMENTS THIS WEEK section is non-empty AND a moment's resolvedAt is today, add at most ONE warm closing sentence acknowledging the close call. Example: "Conductor caught the Health Tech Nerds renewal before it lapsed — handled with 2 days to spare." Only mention if genuinely close (within 72 hours of deadline). Never manufactured — if today's moments are >72h from any deadline, omit. Warm, not boastful. Single sentence, never plural.
- When mentioning a signal more than 14 days out, end that sentence with EXACTLY ONE of these approved phrases — no variations, no additions, no suffixes:
   * "worth watching"
   * "Conductor has its eye on this"
   * "on the radar"
   * "watching for it"
   * "we'll flag it when it matters"
  Never modify these phrases. Never append "as it gets closer" or any other tail. Never use "we're watching" or any other subject substitution — always "Conductor" or one of the passive forms above. Never use the same phrase twice in one brief.
  Use these phrases verbatim only — never append additional words like "one", "too", "as well", or any other suffix. The phrase ends exactly as written.
- Output plain text only. No markdown. No hashtags. No headers.
- Do not begin with a date or header. Start directly with the first sentence.
- If nothing notable happened or is coming, say so confidently — a quiet day is a real outcome
- End with something that closes the day — calm, done, ready for tomorrow
- When referring to a future date, lift the day-and-date verbatim from the friendly string already provided in the ETA field (e.g., "Sunday, May 10"). NEVER compute, infer, or recalculate a day-of-week or date — the resolved string is authoritative. Ignore the "raw:" portion. Drop the year unless it differs from the current year.
- If a signal's ETA is "Unknown" or missing, do NOT invent or guess a date for it — even if the description mentions a holiday or named event. Either omit the date or use a phrase like "no confirmed date yet". Do NOT translate "Mother's Day", "the weekend", or similar phrases into specific calendar dates yourself.
- CRITICAL — NO INVENTED DATE RANGES OR WINDOWS: When a signal has no specific ETA, do NOT fabricate a date range or vague window in place of the missing date. Specifically banned: "sometime between {X} and {Y}", "expected sometime in {month/season}", "by the end of {the year/month/quarter}", "around the {end/middle/start} of {month/year}", "in the next {month/quarter/season} or so", "anywhere from {X} to {Y}", "{date} through {date}" when neither bound came from the authoritative ETA. A signal with no ETA stays dateless — acceptable phrasings: "no confirmed date yet", "still in motion", "details still coming through". Fabricated windows are NEVER acceptable, even when they feel like a reasonable guess.
- The ETA friendly field includes an authoritative parenthesized phrase: "(today)", "(tomorrow)", "(in N days)", "(in N weeks)" (when N is a clean multiple of 7), "(yesterday)", or "(already passed N days ago)". The server picks the unit — never substitute one unit for another (do NOT convert "(in 14 days)" to "in 2 weeks" or "(in 5 days)" to "a few days"). If you want to convey timing, lift that phrase VERBATIM as a contiguous substring of your sentence — character-for-character, including the leading word ("in"). Correct: "renewing in 5 days", "her birthday is in 1 week". Incorrect (even though timing is preserved): "gives you a week to think" (dropped "in", changed "1" → "a"), "a week away" (paraphrased "in 1 week"). Embedding into longer prose is fine as long as the exact authoritative substring is intact. The ONLY two acceptable timing forms are: (1) the lifted parenthesized phrase verbatim, and (2) the day-and-date ("Wednesday, May 20"). Any other quantified duration is forbidden — this is a PATTERN rule, not a list-of-examples rule. The forbidden pattern is "<number-or-quantifier> <time-unit> <preposition>" where number-or-quantifier is anything like "5", "five", "a", "a couple of", "several", "a few", "about two", time-unit is days/weeks/months/years (singular OR plural), and preposition is away/out/left/remaining/from now/to <verb>/until <date>/later/before. Non-exhaustive examples that are ALL forbidden: "five days away", "5 days out", "five days left", "two weeks later", "two weeks out", "two weeks away", "a week out", "a couple of weeks away", "in about three weeks", "a few days from now", "next week", "soon", "shortly". If you find yourself constructing any duration phrase that isn't the lifted parenthesized phrase, stop and use the date alone instead.
- CRITICAL — past-dated signals: when the parenthesized phrase reads "(yesterday)" or "(already passed N days ago)", that signal is in the past. Never frame it as upcoming. Do NOT write "looking ahead to her trip on Friday, May 1", "her spray tan booked for Thursday, May 7", "watch for it as the date approaches", or similar forward-looking phrasing for past-dated items. A past-dated item usually means it's still open or unresolved (a delivery that never came, an appointment unconfirmed); if it warrants mention, frame it as stale/outstanding ("the spray tan from last Thursday still hasn't been confirmed"). If there's no actionable open thread, omit it entirely — do not pad the brief with retrospective recaps of past dates.`,
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
    // Horizon items are vault deadlines — augment with type:"deadline"
    // so the segmenter's idToType map records the canonical type
    // (vault raw category is "subscription"/"insurance"/etc. which
    // isn't in the allowed signalType enum and would otherwise let
    // the segmenter drift to "unknown").
    if (horizonSignal) tagPool.push({ ...horizonSignal, _isDeadline: true, type: "deadline" });
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
    // Run segment tagging, transparency, and (Sunday-only) Week in Review
    // in parallel. Week in Review reads household:{id}:memory for the last
    // 7 days, computes resolution + lapse counts + streak, and asks Claude
    // for a warm one-paragraph reflection. Returns null on non-Sunday or
    // any failure — the field is always present in the response so the
    // mobile renderer can decide whether to show the section.
    // Best-effort household location for evening-cards opportunity gating.
    // The surf-conditions branch needs lat/lon; everything else short-
    // circuits gracefully when location lookup fails.
    let eveningLocation = null;
    try {
      const { loadHouseholdLocation } = await import("./location.js");
      eveningLocation = await loadHouseholdLocation(householdId);
    } catch { /* fall through — non-water cards still ship */ }

    const [segments, transparency, weekInReview, monthInReview, yearInReview, eveningCards] = await Promise.all([
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
      generateWeekInReview(householdId, await loadHouseholdName(householdId)),
      generateMonthInReview(householdId),
      generateYearInReview(householdId),
      generateEveningCards(householdId, {
        signals,
        allDeadlines,
        location: eveningLocation,
      }).catch((err) => {
        console.warn("[clearance] eveningCards top-level failed:", err?.message || err);
        return [];
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

    // Weekly Symphony — Sunday-only field. Pulls the household's
    // current week of achievements + grief-week emotional state to
    // pick major/minor key. Soundtrack assets are placeholders for
    // now; mobile renders the instrument visualization regardless.
    let weeklyAchievements = null;
    try {
      const weekday = new Date().toLocaleDateString("en-US", {
        timeZone: "America/New_York",
        weekday: "short",
      });
      if (weekday === "Sun") {
        const {
          mondayAnchorISO,
          loadWeeklyAchievements,
          symphonyVariationFor,
          symphonySoundSequence,
        } = await import("./signals.js");
        const weekStart = mondayAnchorISO();
        const record = await loadWeeklyAchievements(householdId, weekStart);
        const variation = symphonyVariationFor(record.instrumentsEarned);
        // Minor key when this week saw active grief in any signal.
        let key = "major";
        try {
          const raw = await redis.lrange(`household:${householdId}:signals`, 0, 99);
          const list = (raw || [])
            .map((v) => { try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return null; } })
            .filter(Boolean);
          if (list.some((s) => s?.emotionalValence === "grief")) key = "minor";
        } catch { /* ignore */ }
        weeklyAchievements = {
          instruments: {
            monday:    record.monday,
            tuesday:   record.tuesday,
            wednesday: record.wednesday,
            thursday:  record.thursday,
            friday:    record.friday,
            saturday:  record.saturday,
            sunday:    record.sunday,
          },
          instrumentsEarned: record.instrumentsEarned,
          symphonyVariation: variation,
          symphonyKey: key,
          soundSequence: symphonySoundSequence(record),
          weekStart: record.weekStart,
        };
      }
    } catch (err) {
      console.warn("[clearance] weeklyAchievements failed:", err?.message || err);
    }

    const clearanceResponse = {
      brief,
      segments,
      transparency,
      weekInReview,
      monthInReview,
      yearInReview,
      // Evening cards appear at the bottom of Clearance in the mobile
      // app. The renderer filters out any nulls/empties, so we ship
      // whatever generateEveningCards produced — even if that's [].
      eveningCards: Array.isArray(eveningCards) ? eveningCards.filter(Boolean) : [],
      weeklyAchievements,
      household: householdId,
      user: userName,
      isSingleMember,
    };

    if (userId) {
      await redis.set(
        `user:${userId}:currentClearance`,
        JSON.stringify(clearanceResponse),
        { ex: CURRENT_CLEARANCE_TTL_S }
      );
    }

    return res.status(200).json(clearanceResponse);

  } catch (error) {
    console.error("Clearance error:", error);
    return res.status(500).json({ error: "Failed to generate clearance" });
  }
}
