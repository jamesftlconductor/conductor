import { Redis } from "@upstash/redis";
import { Receiver } from "@upstash/qstash";
import { getValidToken } from "./refresh.js";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// QStash signature verification — only enforced if signing keys are configured.
const receiver =
  process.env.QSTASH_CURRENT_SIGNING_KEY
    ? new Receiver({
        currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
        nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
      })
    : null;

// Disable Vercel's body parser so we can verify the signature against raw bytes.
export const config = {
  api: { bodyParser: false },
  maxDuration: 60,
};

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------- helpers ----------

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function safeJson(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return null; }
}

function safeParseJsonText(text) {
  if (!text) return null;
  const cleaned = text.trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try { return JSON.parse(cleaned); } catch { return null; }
}

async function patchStatus(householdId, partial) {
  const current = safeJson(await redis.get(`household:${householdId}:onboardStatus`)) || { jobs: {} };
  const updated = {
    ...current,
    ...partial,
    jobs: { ...(current.jobs || {}), ...(partial.jobs || {}) },
  };
  await redis.set(`household:${householdId}:onboardStatus`, JSON.stringify(updated));
}

async function patchJob(householdId, jobName, jobUpdate) {
  const current = safeJson(await redis.get(`household:${householdId}:onboardStatus`)) || { jobs: {} };
  const job = current.jobs?.[jobName] || {};
  current.jobs = { ...(current.jobs || {}), [jobName]: { ...job, ...jobUpdate } };
  await redis.set(`household:${householdId}:onboardStatus`, JSON.stringify(current));
}

// Domains that are essentially always personal accounts. A primary
// calendar on one of these is the user's home/social calendar, not
// their work calendar. (Mirrored in api/calendar.js — the two paths
// share calendar-import semantics. Keep in sync.)
const CONSUMER_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com",
  "yahoo.com", "yahoo.co.uk", "ymail.com",
  "hotmail.com", "outlook.com", "live.com", "msn.com",
  "icloud.com", "me.com", "mac.com",
  "aol.com", "protonmail.com", "proton.me",
]);

// True when a Google calendarList entry is the user's work calendar.
// Two heuristics, in priority order:
//   1) Calendar summary contains "work" or "office" as a whole word
//      (matches "Work", "Office", "Work — Engineering", etc.).
//   2) Calendar is the user's primary AND the user's email is on a
//      non-consumer domain — Workspace primary calendars are work
//      calendars in practice. Falls back to false when email domain
//      is unknown rather than guessing.
function isWorkCalendar(cal, userEmail) {
  const summary = (cal?.summary || "").toLowerCase();
  if (/\b(work|office)\b/.test(summary)) return true;
  if (cal?.primary === true && userEmail) {
    const domain = userEmail.split("@")[1]?.toLowerCase();
    if (domain && !CONSUMER_EMAIL_DOMAINS.has(domain)) return true;
  }
  return false;
}

async function callClaude(prompt, maxTokens = 1500) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const j = await r.json();
  return j?.content?.[0]?.text || "";
}

async function fetchEmailMetadata(accessToken, messageId) {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  const headers = data.payload?.headers || [];
  const get = (name) => headers.find((h) => h.name === name)?.value || "";
  return {
    id: messageId,
    subject: get("Subject"),
    from: get("From"),
    date: get("Date"),
    snippet: data.snippet || "",
  };
}

// ---------- Job 1: Email history (12 months back) ----------

async function gmailSearch(accessToken, query, maxResults) {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  return (data.messages || []).map((m) => m.id);
}

async function runEmailJob(userId, householdId) {
  await patchJob(householdId, "emails", { state: "running", startedAt: Date.now() });

  const accessToken = await getValidToken(userId);
  const twelveMonthsAgo = Math.floor((Date.now() - 365 * DAY_MS) / 1000);

  // Two parallel searches: shipping/order signals + dedicated deadline pool.
  // Combined results are deduped; deadline-targeted query gives horizon job
  // much better candidates (insurance/registration/lease/etc.) than the
  // shipping-skewed query alone produces.
  const signalQuery = `after:${twelveMonthsAgo} subject:(tracking OR shipped OR "your order" OR "order confirmed" OR "order shipped" OR delivery OR arriving OR "out for delivery" OR reservation OR flight OR hotel OR appointment)`;

  const deadlineQuery = `after:${twelveMonthsAgo} subject:(insurance OR warranty OR lease OR registration OR passport OR subscription OR renewal OR expires OR expiration OR medical OR dental OR prescription OR tax OR permit OR license)`;

  const [signalIds, deadlineIds] = await Promise.all([
    gmailSearch(accessToken, signalQuery, 50).catch(() => []),
    gmailSearch(accessToken, deadlineQuery, 50).catch(() => []),
  ]);

  // Dedupe by message id (some emails match both queries) and cap combined
  // pool at 80 to stay inside the 60s function budget.
  const seenIds = new Set();
  const messageIds = [];
  for (const id of [...signalIds, ...deadlineIds]) {
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    messageIds.push(id);
    if (messageIds.length >= 80) break;
  }

  await patchJob(householdId, "emails", {
    found: messageIds.length,
    foundFromSignalQuery: signalIds.length,
    foundFromDeadlineQuery: deadlineIds.length,
  });

  if (messageIds.length === 0) {
    await patchJob(householdId, "emails", {
      state: "complete", finishedAt: Date.now(),
      processed: 0, deadlines: 0, signals: 0, patterns: 0,
    });
    return { processed: 0, deadlines: 0, signals: 0, patterns: 0 };
  }

  // Chunk parallel metadata fetches to avoid Gmail per-second quota limits
  // (each metadata call is ~5 units; 66 simultaneously can trip 429s).
  const headers = [];
  for (let i = 0; i < messageIds.length; i += 15) {
    const chunk = messageIds.slice(i, i + 15);
    const chunkResults = await Promise.all(
      chunk.map((id) => fetchEmailMetadata(accessToken, id).catch(() => null))
    );
    headers.push(...chunkResults);
  }
  const validHeaders = headers.filter(Boolean);

  // Dedupe against existing signals by lowercased description.
  const existingRaw = await redis.lrange(`household:${householdId}:signals`, 0, -1);
  const existingDescriptions = new Set(
    existingRaw
      .map((s) => safeJson(s))
      .filter(Boolean)
      .map((s) => (s.description || "").toLowerCase().trim())
      .filter(Boolean)
  );

  // Same dedup pattern for vault — the deadline branch below now writes to
  // :vault rather than :deadlines (single source of truth). Built once
  // outside the per-batch loop so we only pay the lrange cost once.
  const existingVaultRaw = await redis.lrange(`household:${householdId}:vault`, 0, -1);
  const existingVaultDescs = new Set(
    existingVaultRaw
      .map((s) => safeJson(s))
      .filter(Boolean)
      .map((v) => (v.description || "").toLowerCase().trim())
      .filter(Boolean)
  );
  function isDuplicateVaultDesc(desc) {
    if (!desc) return true;
    if (existingVaultDescs.has(desc)) return true;
    for (const ex of existingVaultDescs) {
      if (ex.length >= 6 && desc.length >= 6 && (ex.includes(desc) || desc.includes(ex))) return true;
    }
    return false;
  }

  let totalDeadlines = 0;
  let totalSignals = 0;
  let totalPatterns = 0;

  const todayIso = new Date().toISOString().slice(0, 10);

  for (let i = 0; i < validHeaders.length; i += 10) {
    const batch = validHeaders.slice(i, i + 10);
    const formatted = batch
      .map((e, n) => `[${n}] Subject: ${e.subject}\nFrom: ${e.from}\nDate: ${e.date}\nSnippet: ${e.snippet.substring(0, 200)}`)
      .join("\n\n");

    const text = await callClaude(
      `Today is ${todayIso}.

Analyze these emails and extract any of the following if present:
1. Document deadlines — insurance renewals, warranties, subscriptions, leases, registrations, medical. Return as: { type: "deadline", description, date, category }
2. Active signals — packages, deliveries, appointments, reservations still relevant in the next 30 days. Return as: { type: "signal", description, eta, sender, signalType }
3. Patterns — recurring services, subscriptions, behaviors. Return as: { type: "pattern", description, frequency }

CRITICAL: Only return deadlines whose date is on or after ${todayIso}. Many emails are months old and reference dates that have already passed — those specific past dates are not actionable.

However, do still extract deadlines that are forward-looking even if mentioned in older emails. Examples:
- A renewal email from last year that says "your policy renews each May" — extract the upcoming May renewal as a future-dated deadline.
- A confirmation that says "valid through 2027" — extract "2027" as a deadline.
- A registration whose date is ambiguous but the email implies an upcoming renewal cycle — make a best-effort guess at the next future occurrence.

Only skip items whose date is unambiguously and clearly in the past (a specific calendar date that has already happened with no forward-looking implication). When in doubt, include it with the next plausible future date.

Return ONLY a JSON array of found items. Empty array if nothing relevant.

Emails:
${formatted}`,
      1500
    );
    const items = safeParseJsonText(text);
    if (!Array.isArray(items)) continue;

    for (const item of items) {
      if (!item || typeof item !== "object" || !item.type) continue;
      const desc = (item.description || "").toLowerCase().trim();

      if (item.type === "deadline") {
        // Belt-and-suspenders: drop deadlines whose ETA already passed.
        // Claude is told today's date in the prompt, but we also enforce
        // here in case it slips through (typo, ambiguous email, etc.).
        const etaMs = item.date ? Date.parse(item.date) : NaN;
        if (!isNaN(etaMs) && etaMs < Date.now()) continue;
        if (isDuplicateVaultDesc(desc)) continue;
        existingVaultDescs.add(desc);

        // Write to :vault (not :deadlines) so brief.js's deadline pool sees
        // these. The dedicated vault sweep (Job 3) is strict and tends to
        // null-out auto-renewals; this branch picks up the action-bearing
        // deadlines the broader email query catches. Source tag distinguishes
        // them from the per-email vault sweep entries.
        await redis.lpush(`household:${householdId}:vault`, JSON.stringify({
          id: `vault_email_${Date.now()}_${totalDeadlines}`,
          category: item.category || "other",
          description: item.description,
          provider: null,
          renewalDate: item.date,
          amount: null,
          consequence: null,
          confidence: "medium",
          source: "email-sweep",
          foundAt: Date.now(),
        }));
        totalDeadlines++;
      } else if (item.type === "signal") {
        if (!desc || existingDescriptions.has(desc)) continue;
        existingDescriptions.add(desc);
        await redis.lpush(`household:${householdId}:signals`, JSON.stringify({
          id: Date.now() + totalSignals,
          description: item.description,
          eta: item.eta,
          sender: item.sender,
          type: item.signalType || "unknown",
          status: "Unknown",
          state: "incoming",
          source: "onboard",
          userId,
          lastUpdate: new Date().toLocaleString(),
        }));
        totalSignals++;
      } else if (item.type === "pattern") {
        await redis.lpush(`household:${householdId}:patterns`, JSON.stringify({
          id: `pattern_${Date.now()}_${totalPatterns}`,
          description: item.description,
          frequency: item.frequency,
          source: "onboard:emails",
          createdAt: Date.now(),
        }));
        totalPatterns++;
      }
    }

    await patchJob(householdId, "emails", {
      processed: Math.min(i + 10, validHeaders.length),
      deadlines: totalDeadlines,
      signals: totalSignals,
      patterns: totalPatterns,
    });
  }

  await patchJob(householdId, "emails", { state: "complete", finishedAt: Date.now() });
  return {
    processed: validHeaders.length,
    deadlines: totalDeadlines,
    signals: totalSignals,
    patterns: totalPatterns,
  };
}

// ---------- Job 2: Calendar history (24 months back, 12 months forward) ----------

async function runCalendarJob(userId, householdId) {
  await patchJob(householdId, "calendar", { state: "running", startedAt: Date.now() });

  const accessToken = await getValidToken(userId);
  const now = Date.now();
  const twentyFourMonthsAgo = new Date(now - 24 * 30 * DAY_MS).toISOString();
  const twelveMonthsAhead = new Date(now + 12 * 30 * DAY_MS).toISOString();

  // Resolve the user's email so the Workspace-primary heuristic in
  // isWorkCalendar can fire. Best-effort — if the profile is missing
  // we still classify by calendar name.
  let userEmail = null;
  try {
    const profileRaw = await redis.get(`user:${userId}:profile`);
    const profile = typeof profileRaw === "string" ? JSON.parse(profileRaw) : profileRaw;
    userEmail = profile?.email || null;
  } catch {
    // ignored — userEmail stays null
  }

  const calListRes = await fetch(
    "https://www.googleapis.com/calendar/v3/users/me/calendarList",
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const calList = await calListRes.json();
  const calendars = calList.items || [];

  // Identify work calendars from metadata before any events are fetched.
  // Events sourced from these calendars get pre-tagged as work below
  // and skip the per-event LLM classification call entirely.
  const workCalendarIds = new Set();
  for (const cal of calendars) {
    if (isWorkCalendar(cal, userEmail)) workCalendarIds.add(cal.id);
  }
  await patchJob(householdId, "calendar", {
    calendarsTotal: calendars.length,
    workCalendars: workCalendarIds.size,
  });

  const allEvents = [];
  for (const cal of calendars) {
    try {
      const eventsRes = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?` +
        `timeMin=${encodeURIComponent(twentyFourMonthsAgo)}&` +
        `timeMax=${encodeURIComponent(twelveMonthsAhead)}&` +
        `singleEvents=true&orderBy=startTime&maxResults=250`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const eventsData = await eventsRes.json();
      for (const event of eventsData.items || []) {
        allEvents.push({
          id: event.id,
          title: event.summary || "Untitled",
          description: event.description || "",
          start: event.start?.dateTime || event.start?.date,
          end: event.end?.dateTime || event.end?.date,
          calendar: cal.summary,
          calendarId: cal.id,
          // Google's structured event-type signal — "outOfOffice" and
          // "focusTime" are explicit availability blockers regardless
          // of which calendar they came from.
          eventType: event.eventType || "default",
          userId,
        });
      }
    } catch {
      continue;
    }
  }

  await patchJob(householdId, "calendar", { found: allEvents.length });

  // Recurring patterns from past events: same title 3+ times in past 24 months.
  const titleCounts = {};
  for (const ev of allEvents) {
    const start = Date.parse(ev.start);
    if (!isNaN(start) && start < now) {
      titleCounts[ev.title] = (titleCounts[ev.title] || 0) + 1;
    }
  }
  let patternsAdded = 0;
  for (const [title, count] of Object.entries(titleCounts)) {
    if (count >= 3 && title !== "Untitled") {
      await redis.lpush(`household:${householdId}:patterns`, JSON.stringify({
        id: `pattern_cal_${Date.now()}_${patternsAdded}`,
        description: title,
        frequency: `${count} occurrences in past 24 months`,
        source: "onboard:calendar",
        createdAt: Date.now(),
      }));
      patternsAdded++;
    }
  }

  // Classify upcoming events only — bounded for budget. Bumped from 100
  // to 200 so a busy work calendar comfortably covers two weeks; the
  // pre-tagging pass below means most work events skip the LLM, so the
  // Claude cost increase is sub-linear in practice.
  const upcoming = allEvents
    .filter((e) => {
      const start = Date.parse(e.start);
      return !isNaN(start) && start >= now;
    })
    .slice(0, 200);

  // Partition: structurally-known work events vs ambiguous events that
  // still need the LLM. An event is structurally work if either:
  //  - It came from a work calendar (workCalendarIds, by metadata)
  //  - It's a Google "outOfOffice" or "focusTime" event (the API's own
  //    explicit availability marker)
  // Pre-tagged events skip Claude entirely.
  const preTagged = [];
  const needsClassification = [];
  for (const ev of upcoming) {
    const fromWorkCal = workCalendarIds.has(ev.calendarId);
    const structurallyBlocking =
      ev.eventType === "outOfOffice" || ev.eventType === "focusTime";
    if (fromWorkCal || structurallyBlocking) {
      preTagged.push({
        ...ev,
        type: "work",
        householdRelevant: false,
        workConflictCheck: true,
        tags: structurallyBlocking ? [ev.eventType] : ["work"],
        classifiedBy: fromWorkCal ? "work-calendar" : "event-type",
      });
    } else {
      needsClassification.push(ev);
    }
  }

  const classified = [...preTagged];
  await patchJob(householdId, "calendar", {
    classified: classified.length,
    preTagged: preTagged.length,
    needsClassification: needsClassification.length,
  });

  for (let i = 0; i < needsClassification.length; i += 10) {
    const batch = needsClassification.slice(i, i + 10);
    const results = await Promise.all(batch.map(async (event) => {
      try {
        const text = await callClaude(
          `Classify this calendar event. Return ONLY a JSON object with:
- type: "household" | "work" | "personal" | "travel" | "childcare"
- householdRelevant: true | false
- workConflictCheck: true | false (true if this blocks the person and could conflict with household events)
- tags: array of relevant tags like ["kids", "school", "childcare", "medical"]

Event: "${event.title}"
Calendar: "${event.calendar}"
Description: "${event.description?.substring(0, 200) || ""}"

Return only the JSON object.`,
          150
        );
        const cls = safeParseJsonText(text);
        return {
          ...event,
          ...(cls || { type: "unknown", householdRelevant: false, workConflictCheck: false, tags: [] }),
          classifiedBy: cls ? "llm" : "llm-fallback",
        };
      } catch {
        return {
          ...event,
          type: "unknown",
          householdRelevant: false,
          workConflictCheck: false,
          tags: [],
          classifiedBy: "llm-error",
        };
      }
    }));
    classified.push(...results);
    await patchJob(householdId, "calendar", { classified: classified.length });
  }

  await redis.set(
    `household:${householdId}:calendar`,
    JSON.stringify(classified),
    { ex: 60 * 60 * 24 * 30 } // 30-day cache for the longer horizon
  );

  await patchJob(householdId, "calendar", {
    state: "complete",
    finishedAt: Date.now(),
    patternsAdded,
    classified: classified.length,
    preTagged: preTagged.length,
    workCalendars: workCalendarIds.size,
  });

  return {
    events: allEvents.length,
    classified: classified.length,
    preTagged: preTagged.length,
    workCalendars: workCalendarIds.size,
    patterns: patternsAdded,
  };
}

// ---------- Job 3: Vault sweep ----------
//
// Dedicated Gmail sweep that targets deadline-bearing subjects, then asks
// Claude one-by-one (per the spec) to extract a structured vault item per
// email. Filters out items with no renewal date or one that's already past
// by more than 30 days, then dedupes by description similarity before LPUSH
// into household:{id}:vault. The horizon job (run after this) consumes
// :vault rather than :deadlines.

async function runVaultJob(userId, householdId) {
  await patchJob(householdId, "vault", { state: "running", startedAt: Date.now() });

  const accessToken = await getValidToken(userId);
  const twelveMonthsAgo = Math.floor((Date.now() - 365 * DAY_MS) / 1000);

  const query =
    `after:${twelveMonthsAgo} subject:(insurance OR registration OR renewal OR expires OR ` +
    `expiration OR warranty OR lease OR subscription OR license OR passport OR membership OR ` +
    `"due date" OR "renew by" OR "expires on" OR "annual fee" OR "auto-renew")`;

  const messageIds = await gmailSearch(accessToken, query, 100).catch(() => []);
  await patchJob(householdId, "vault", { found: messageIds.length });

  if (messageIds.length === 0) {
    await patchJob(householdId, "vault", {
      state: "complete",
      finishedAt: Date.now(),
      processed: 0,
      kept: 0,
      dropped: 0,
    });
    return { processed: 0, kept: 0 };
  }

  // Metadata fetch in parallel chunks of 15 (matches the email-job pattern;
  // larger chunks risk Gmail per-second quota).
  const headers = [];
  for (let i = 0; i < messageIds.length; i += 15) {
    const chunk = messageIds.slice(i, i + 15);
    const chunkResults = await Promise.all(
      chunk.map((id) => fetchEmailMetadata(accessToken, id).catch(() => null))
    );
    headers.push(...chunkResults);
  }
  const validHeaders = headers.filter(Boolean);

  // Existing vault descriptions for dedup. Same lowercased-substring overlap
  // pattern used in the email/deadlines path.
  const existingRaw = await redis.lrange(`household:${householdId}:vault`, 0, -1);
  const existingDescriptions = new Set(
    existingRaw
      .map(safeJson)
      .filter(Boolean)
      .map((v) => (v.description || "").toLowerCase().trim())
      .filter(Boolean)
  );
  function isDuplicateDescription(desc) {
    if (!desc) return true;
    if (existingDescriptions.has(desc)) return true;
    for (const ex of existingDescriptions) {
      if (ex.length >= 6 && desc.length >= 6 && (ex.includes(desc) || desc.includes(ex))) {
        return true;
      }
    }
    return false;
  }

  let processed = 0;
  let kept = 0;
  let dropped = 0;
  const PARALLEL = 10;

  for (let i = 0; i < validHeaders.length; i += PARALLEL) {
    const batch = validHeaders.slice(i, i + PARALLEL);
    const items = await Promise.all(
      batch.map(async (e) => {
        const text = await callClaude(
          `Extract any deadline, renewal, or expiration from this email. Return ONLY a JSON object or null if nothing found:
{
  "category": "insurance" | "registration" | "subscription" | "lease" | "warranty" | "medical" | "financial" | "legal" | "membership" | "other",
  "description": "what this is",
  "provider": "company or organization name",
  "renewalDate": "YYYY-MM-DD or null",
  "amount": "dollar amount per year if known or null",
  "consequence": "what happens if missed in 5 words or less",
  "confidence": "high" | "medium" | "low"
}
Only return something if there is a clear deadline or renewal date. Return null if this is purely promotional.

Email:
Subject: ${e.subject}
From: ${e.from}
Date: ${e.date}
Snippet: ${(e.snippet || "").substring(0, 400)}`,
          300
        ).catch(() => null);
        return safeParseJsonText(text);
      })
    );

    for (const item of items) {
      processed++;
      if (!item || typeof item !== "object" || !item.renewalDate) {
        dropped++;
        continue;
      }
      const renewalMs = Date.parse(item.renewalDate);
      if (isNaN(renewalMs) || renewalMs < Date.now() - 30 * DAY_MS) {
        dropped++;
        continue;
      }
      const desc = (item.description || "").toLowerCase().trim();
      if (isDuplicateDescription(desc)) {
        dropped++;
        continue;
      }
      existingDescriptions.add(desc);

      await redis.lpush(
        `household:${householdId}:vault`,
        JSON.stringify({
          id: `vault_${Date.now()}_${kept}`,
          category: item.category || "other",
          description: item.description,
          provider: item.provider || null,
          renewalDate: item.renewalDate,
          amount: item.amount || null,
          consequence: item.consequence || null,
          confidence: item.confidence || "low",
          source: "gmail",
          foundAt: Date.now(),
        })
      );
      kept++;
    }

    await patchJob(householdId, "vault", { processed, kept, dropped });
  }

  await patchJob(householdId, "vault", {
    state: "complete",
    finishedAt: Date.now(),
    processed,
    kept,
    dropped,
  });
  return { processed, kept, dropped };
}

// ---------- Job 4: Horizon selection ----------

const SURPRISING_KEYWORDS = [
  "insurance", "renewal", "lease", "registration",
  "warranty", "license", "passport", "tax", "premium", "policy",
];

async function runHorizonJob(householdId) {
  await patchJob(householdId, "horizon", { state: "running", startedAt: Date.now() });

  // Switched from :deadlines to :vault in the vault flow. Vault items use
  // renewalDate; map to the {description, eta, category} shape the rest of
  // this code expects.
  const rawVault = await redis.lrange(`household:${householdId}:vault`, 0, -1);
  const vaultItems = rawVault
    .map(safeJson)
    .filter(Boolean)
    .filter((v) => !v.handled)
    .map((v) => ({
      id: v.id,
      description: v.description,
      eta: v.renewalDate,
      category: v.category,
    }));

  const candidates = vaultItems.filter((d) => {
    const ms = Date.parse(d.eta);
    if (isNaN(ms)) return false;
    const days = (ms - Date.now()) / DAY_MS;
    // 7-90 days: includes near-term renewals that are still meaningfully
    // "horizon" rather than urgent-today signals.
    return days >= 7 && days <= 90;
  });

  const scored = candidates.map((d) => {
    const text = `${d.description || ""} ${d.category || ""}`.toLowerCase();
    const score = SURPRISING_KEYWORDS.reduce((acc, k) => acc + (text.includes(k) ? 10 : 0), 0);
    return { d, score };
  });
  scored.sort((a, b) => b.score - a.score || Date.parse(a.d.eta) - Date.parse(b.d.eta));

  const horizonSignal = scored[0]?.d || null;

  if (horizonSignal) {
    await redis.set(
      `household:${householdId}:horizon`,
      JSON.stringify({ signal: horizonSignal, timestamp: Date.now() })
    );
    await redis.lpush(`household:${householdId}:briefed`, String(horizonSignal.id));
  }

  await patchJob(householdId, "horizon", {
    state: "complete",
    finishedAt: Date.now(),
    selected: horizonSignal ? { description: horizonSignal.description, eta: horizonSignal.eta } : null,
  });

  return horizonSignal
    ? { description: horizonSignal.description, date: horizonSignal.eta }
    : null;
}

// ---------- Handler ----------

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body;
  try {
    const raw = await readRawBody(req);

    if (receiver) {
      const signature = req.headers["upstash-signature"];
      const ok = await receiver
        .verify({ signature: signature || "", body: raw })
        .catch(() => false);
      if (!ok) return res.status(401).json({ error: "Invalid signature" });
    }

    body = JSON.parse(raw);
  } catch (err) {
    console.error("Worker body parse error:", err);
    return res.status(400).json({ error: "Invalid body" });
  }

  const { userId, householdId } = body;
  if (!userId || !householdId) {
    return res.status(400).json({ error: "Missing userId or householdId" });
  }

  await patchStatus(householdId, { state: "running" });

  // Each job runs independently — failure of one doesn't stop the others.
  let emailResult = null;
  try {
    emailResult = await runEmailJob(userId, householdId);
  } catch (err) {
    console.error("Email job failed:", err);
    await patchJob(householdId, "emails", { state: "failed", error: err.message });
  }

  let calendarResult = null;
  try {
    calendarResult = await runCalendarJob(userId, householdId);
  } catch (err) {
    console.error("Calendar job failed:", err);
    await patchJob(householdId, "calendar", { state: "failed", error: err.message });
  }

  let vaultResult = null;
  try {
    vaultResult = await runVaultJob(userId, householdId);
  } catch (err) {
    console.error("Vault job failed:", err);
    await patchJob(householdId, "vault", { state: "failed", error: err.message });
  }

  let horizonResult = null;
  try {
    horizonResult = await runHorizonJob(householdId);
  } catch (err) {
    console.error("Horizon job failed:", err);
    await patchJob(householdId, "horizon", { state: "failed", error: err.message });
  }

  await patchStatus(householdId, {
    state: "complete",
    finishedAt: Date.now(),
    summary: {
      emailsProcessed: emailResult?.processed || 0,
      deadlinesFound: emailResult?.deadlines || 0,
      signalsFound: emailResult?.signals || 0,
      patternsFound: (emailResult?.patterns || 0) + (calendarResult?.patterns || 0),
      calendarEventsProcessed: calendarResult?.classified || 0,
      vaultProcessed: vaultResult?.processed || 0,
      vaultKept: vaultResult?.kept || 0,
      horizonSignal: horizonResult,
    },
  });

  return res.status(200).json({ ok: true });
}
