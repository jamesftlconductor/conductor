import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

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

    const [rawSignals, rawCal, rawDeadlines, rawHorizon, rawBriefed] = await Promise.all([
      redis.lrange(`household:${householdId}:signals`, 0, -1),
      redis.get(`household:${householdId}:calendar`),
      redis.lrange(`household:${householdId}:deadlines`, 0, -1),
      redis.get(`household:${householdId}:horizon`),
      redis.lrange(`household:${householdId}:briefed`, 0, -1),
    ]);

    const signals = (rawSignals || []).map(s => typeof s === "string" ? JSON.parse(s) : s);
    const briefedIds = new Set((rawBriefed || []).map(s => String(s)));

    const resolvedToday = [];
    const expiredToday = [];
    const stillActive = [];
    const carryingForward = [];

    for (const s of signals) {
      const eta = parseDateLoose(s.eta);
      const lastUpdate = parseDateLoose(s.lastUpdate);

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

      if ((s.state === "incoming" || s.state === "active") && eta && eta > now) {
        stillActive.push(s);
      }

      if (s.status === "Delayed" && s.state !== "expired" && s.state !== "resolved" && (!eta || eta > now)) {
        carryingForward.push(s);
      }
    }

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
      else if (days > 3 && days <= 14) nearDeadlines.push(tagged);
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
      if (s._isDeadline) {
        return `- [DEADLINE] ${s.description || "Unknown"} | Due: ${etaWithFriendly(s.eta)} | Category: ${s.category || "uncategorized"}`;
      }
      return `- ${s.description || "Unknown item"} from ${s.sender || "Unknown"} | Status: ${s.status || "Unknown"} | ETA: ${etaWithFriendly(s.eta)} | Type: ${s.type || "unknown"}`;
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

    const tomorrowSummary = tomorrowEvents
      .map(e => {
        const friendly = friendlyDateTime(e.start);
        const when = friendly || (e.start ? `raw: ${e.start}` : "Unknown");
        return `- ${e.title} | ${when} | Owner: ${e.userId}`;
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

Resolved or arrived today:
${resolvedSummary || "None"}

Expired today (didn't arrive as expected):
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

Important: ignore promotional events, store launches, marketing emails, and account/loyalty notifications. Only narrate signals that represent real deliveries, services, reservations, or travel — things with a concrete arrival, commitment, or action. Deadlines (marked [DEADLINE]) are documents/renewals/registrations the user needs to handle — surface them naturally in the close-of-day reflection.

On the household calendar tomorrow:
${tomorrowSummary || "None"}

Rules:
- Write in natural, flowing prose — not a list
- 3-5 sentences maximum
- Lead with what resolved or arrived today
- Note what's still in motion without alarm — these are simply continuing
- Surface anything important tomorrow so it lands gently in advance
- Skip signals with no useful information
- Tone: reflective, closing the day, like a thought ${userName} was already having as the evening settles
- Never say "here is your brief" or use assistant language
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

    const tagSet = [
      ...resolvedToday,
      ...expiredToday,
      ...stillActive,
      ...carryingForward,
      ...urgentDeadlines,
      ...nearDeadlines,
    ];
    if (horizonSignal) tagSet.push(horizonSignal);
    const segments = await tagBriefSegments(brief, tagSet);

    return res.status(200).json({ brief, segments, household: householdId, user: userName });

  } catch (error) {
    console.error("Clearance error:", error);
    return res.status(500).json({ error: "Failed to generate clearance" });
  }
}
