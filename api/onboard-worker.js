import { Redis } from "@upstash/redis";
import { Client, Receiver } from "@upstash/qstash";
import { getValidToken } from "./refresh.js";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const qstash = process.env.QSTASH_TOKEN
  ? new Client({
      token: process.env.QSTASH_TOKEN,
      ...(process.env.QSTASH_URL ? { baseUrl: process.env.QSTASH_URL } : {}),
    })
  : null;

const WORKER_URL = "https://conductor-ivory.vercel.app/api/onboard-worker";

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

const ALL_JOBS = ["emails", "calendar", "vault", "crew", "horizon"];
const TERMINAL_STATES = new Set(["complete", "failed", "skipped"]);

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

// Status is stored as a Redis hash with flat fields: `state`, `startedAt`,
// `finishedAt`, `summary`, plus one `job:<name>` field per job carrying that
// job's serialised state. Each job only writes its own `job:<name>` field,
// so concurrent per-job HSETs from parallel QStash invocations don't race
// with each other.
const statusKey = (hid) => `household:${hid}:onboardStatus`;

async function patchStatus(householdId, partial) {
  const update = {};
  for (const [k, v] of Object.entries(partial)) {
    if (k === "jobs") continue;
    update[k] = typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  if (Object.keys(update).length > 0) {
    await redis.hset(statusKey(householdId), update);
  }
  if (partial.jobs) {
    for (const [name, jobUpdate] of Object.entries(partial.jobs)) {
      await patchJob(householdId, name, jobUpdate);
    }
  }
}

async function patchJob(householdId, jobName, jobUpdate) {
  const field = `job:${jobName}`;
  const current = safeJson(await redis.hget(statusKey(householdId), field)) || {};
  const merged = { ...current, ...jobUpdate };
  await redis.hset(statusKey(householdId), { [field]: JSON.stringify(merged) });
}

async function readJobStates(householdId) {
  const hash = await redis.hgetall(statusKey(householdId));
  if (!hash) return {};
  const jobs = {};
  for (const name of ALL_JOBS) {
    const raw = hash[`job:${name}`];
    jobs[name] = raw ? safeJson(raw) : null;
  }
  return { jobs, top: hash };
}

// Called after each job completes (or fails). If every job has reached a
// terminal state, flip the top-level `state` to "complete" and write the
// aggregate summary. Idempotent — multiple concurrent calls converge.
async function maybeFinalize(householdId) {
  const { jobs, top } = await readJobStates(householdId);
  if (!jobs) return;
  const allDone = ALL_JOBS.every((n) => jobs[n] && TERMINAL_STATES.has(jobs[n].state));
  if (!allDone) return;
  if (top.state === "complete") return;
  await redis.hset(statusKey(householdId), {
    state: "complete",
    finishedAt: String(Date.now()),
    summary: JSON.stringify({
      emailsProcessed: jobs.emails?.processed || 0,
      deadlinesFound: jobs.emails?.deadlines || 0,
      signalsFound: jobs.emails?.signals || 0,
      patternsFound: (jobs.emails?.patterns || 0) + (jobs.calendar?.patternsAdded || 0),
      calendarEventsProcessed: jobs.calendar?.classified || 0,
      vaultProcessed: jobs.vault?.processed || 0,
      vaultKept: jobs.vault?.kept || 0,
      crewProcessed: jobs.crew?.processed || 0,
      crewMembers: jobs.crew?.members || 0,
      horizonSignal: jobs.horizon?.selected || null,
    }),
  });
}

// Enqueue a single job. Mirrors the fan-out logic in api/onboard.js: prefer
// QStash, fall back to direct fire-and-forget if QStash isn't configured or
// publish fails. Used by the vault job to chain horizon on success.
async function enqueueJob({ userId, householdId, job }) {
  if (qstash) {
    try {
      await qstash.publishJSON({
        url: WORKER_URL,
        body: { userId, householdId, job },
        retries: 1,
      });
      return;
    } catch (qErr) {
      console.error(`QStash publish for ${job} failed, falling back to direct fetch:`, qErr.message);
    }
  }
  fetch(WORKER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, householdId, job }),
  }).catch(() => {});
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

// Strip HTML tags + common entities so a marketing-email body
// (24KB+ of <meta>/<style>/Outlook conditionals) collapses to its
// readable text. Without this, the body prefix is all CSS/HTML chrome
// and Claude gets no usable content in the first 3000 chars.
function htmlToText(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Full-body variant for the vault sweep. Walks the MIME tree for
// text/plain first; falls back to text/html + HTML-strip if that's
// all the sender provides. Returns both `snippet` (Gmail's
// content-aware preview, often gold) and `body` (full readable
// text) so the prompt can use both.
async function fetchEmailFullBody(accessToken, messageId) {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  const headers = data.payload?.headers || [];
  const get = (name) => headers.find((h) => h.name === name)?.value || "";

  // Try text/plain first across both top-level parts and one level of
  // nesting (multipart/alternative wrappers). Mark the source so we
  // know whether to strip HTML below.
  let body = "";
  let bodyIsHtml = false;
  const parts = data.payload?.parts || [];
  for (const part of parts) {
    if (part.mimeType === "text/plain" && part.body?.data) {
      body = Buffer.from(part.body.data, "base64").toString("utf-8");
      break;
    }
  }
  if (!body) {
    for (const part of parts) {
      for (const nested of (part.parts || [])) {
        if (nested.mimeType === "text/plain" && nested.body?.data) {
          body = Buffer.from(nested.body.data, "base64").toString("utf-8");
          break;
        }
      }
      if (body) break;
    }
  }
  // Fall back to text/html (top-level or nested) if no text/plain.
  if (!body) {
    for (const part of parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        body = Buffer.from(part.body.data, "base64").toString("utf-8");
        bodyIsHtml = true;
        break;
      }
      for (const nested of (part.parts || [])) {
        if (nested.mimeType === "text/html" && nested.body?.data) {
          body = Buffer.from(nested.body.data, "base64").toString("utf-8");
          bodyIsHtml = true;
          break;
        }
      }
      if (body) break;
    }
  }
  // Single-body payload (rare, e.g. plain-text-only senders).
  if (!body && data.payload?.body?.data) {
    body = Buffer.from(data.payload.body.data, "base64").toString("utf-8");
    if ((data.payload.mimeType || "").includes("html")) bodyIsHtml = true;
  }
  if (bodyIsHtml) body = htmlToText(body);

  return {
    id: messageId,
    subject: get("Subject"),
    from: get("From"),
    date: get("Date"),
    snippet: data.snippet || "",
    body,
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
  // Word-overlap dedup against existing vault items, mirroring the
  // Job 3 fix. Uses vaultDescriptionOverlap > 0.5 within a 30-day
  // renewalDate window so we catch "Health Tech Nerds subscription
  // renewal" vs "Health Tech Nerds Membership - Monthly subscription
  // renewal" while still permitting separate annual renewals of the
  // same item from year to year.
  const existingVaultRaw = await redis.lrange(`household:${householdId}:vault`, 0, -1);
  const existingVaultItems = existingVaultRaw.map(safeJson).filter(Boolean);
  const VAULT_DEDUP_WINDOW_MS = 30 * DAY_MS;
  function isDuplicateVaultItem(desc, dateStr) {
    if (!desc) return true;
    const itemMs = dateStr ? Date.parse(dateStr) : NaN;
    if (isNaN(itemMs)) return false;
    for (const ex of existingVaultItems) {
      const exMs = ex.renewalDate ? Date.parse(ex.renewalDate) : NaN;
      if (isNaN(exMs) || Math.abs(itemMs - exMs) > VAULT_DEDUP_WINDOW_MS) continue;
      if (vaultDescriptionOverlap(desc, ex.description) > 0.5) return true;
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
        if (isDuplicateVaultItem(desc, item.date)) continue;
        existingVaultItems.push({ description: item.description, renewalDate: item.date });

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

  // Per-user calendar key — under multi-driver sync, each member writes
  // their own slice and consumers merge via api/calendar-loader.js. The
  // legacy single-key write is dropped; the loader still falls back to
  // it for households whose sync hasn't run since the deploy.
  await redis.set(
    `household:${householdId}:calendar:${userId}`,
    JSON.stringify(classified),
    { ex: 60 * 60 * 24 * 30 }
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

// Five specialized passes replace the previous single broad sweep. Each
// pass targets a vertical (insurance, subscriptions, prescriptions/medical,
// warranties, registrations/legal) with its own Gmail query and a tailored
// Claude prompt that asks for vertical-specific fields (subtype, policy
// number, frequency, etc.) on top of the shared schema. Passes run in
// parallel via Promise.all; cross-pass dedup runs after all returns.
//
// The narrow queries trade recall for precision: each pass surfaces a
// smaller, more focused result set, and the prompts can be more confident
// about the expected shape — fewer "is this a real renewal or just a
// marketing email" judgment calls per pass.

// Vault queries require BOTH a category keyword AND a renewal/action
// verb in the subject — single-clause queries (e.g. bare "Netflix" or
// "State Farm") match every email those senders deliver, drowning
// Claude in 100% noise. Two subject:() clauses are implicit-AND'd by
// Gmail. Verified 2026-05-14: previous queries scanned 74 emails and
// extracted 0; every drop was claudeEmpty because Claude correctly
// rejected marketing/account-update mail the brand-only filters caught.
// Single-clause subject queries — the prior two-clause AND form was
// returning 0 results across most passes against James's actual Gmail
// because real renewal emails rarely carry BOTH a category keyword
// (e.g. "insurance") and a renewal-action keyword (e.g. "renewal") in
// the subject simultaneously. State Farm emails titled "Your Policy"
// missed the renewal clause; "Your GoDaddy Renewal Notice" missed the
// registration clause. Loosened to a single broad subject match per
// category; the prompt instructions below carry the "drop if purely
// promotional" precision filter.
const VAULT_PASSES = [
  {
    key: "insurance",
    query:
      `subject:(insurance OR policy OR coverage OR premium OR deductible OR ` +
      `"policy renewal notice" OR "your annual renewal" OR "renewal invoice" OR ` +
      `"premium notice" OR "your policy renews")`,
    instructions: `Extract insurance policy information. Return JSON or null:
{ "category": "insurance", "subtype": "auto|home|health|dental|vision|life|renters|other", "description": "specific policy description", "provider": "company name", "renewalDate": "YYYY-MM-DD or null", "amount": "annual premium if known or null", "policyNumber": "if visible or null", "consequence": "what lapses if missed", "confidence": "high|medium|low" }
Return the item whenever you can identify BOTH a provider AND a renewal date, even at low confidence — a real date plus a known issuer is enough to be useful. Drop only if either is missing, the renewal date is more than 60 days in the past, or the email is purely promotional with no policy reference.`,
  },
  {
    key: "subscriptions",
    query:
      `subject:(subscription OR membership OR "annual plan" OR "monthly plan" OR ` +
      `"auto-renew" OR "auto-renews" OR "auto-renewal" OR "membership fee" OR ` +
      `"annual fee" OR "billing date" OR "next charge")`,
    instructions: `Extract subscription or membership renewal. Return JSON or null:
{ "category": "subscription", "subtype": "streaming|software|membership|service|other", "description": "what this subscription is for", "provider": "company name", "renewalDate": "YYYY-MM-DD or null", "amount": "monthly or annual cost if known or null", "frequency": "monthly|annual|other", "consequence": "service stops or auto-charges", "confidence": "high|medium|low" }
Return the item whenever you can identify BOTH a provider AND a renewal date, even at low confidence. Drop only if either is missing or the email is a pure promotional offer with no real subscription.`,
  },
  {
    key: "medical",
    query:
      `subject:(prescription OR pharmacy OR FSA OR HSA OR "health benefits" OR ` +
      `medication OR refill OR "open enrollment" OR "days supply" OR ` +
      `"use it or lose it")`,
    instructions: `Extract prescription or medical benefit information. Return JSON or null:
{ "category": "medical", "subtype": "prescription|FSA|HSA|benefits|appointment|other", "description": "medication name or benefit type", "provider": "pharmacy or insurer name", "renewalDate": "YYYY-MM-DD — next refill date or benefit expiry or null", "amount": "cost if known or null", "consequence": "runs out or expires or lapses", "confidence": "high|medium|low" }
Return the item whenever you can identify BOTH a provider AND an actionable date, even at low confidence. Drop only if either is missing or the email is purely promotional.`,
  },
  {
    key: "warranties",
    query:
      `subject:(warranty OR AppleCare OR "protection plan" OR "service contract" OR ` +
      `"coverage plan" OR "product protection" OR "extended warranty")`,
    instructions: `Extract warranty or service contract information. Return JSON or null:
{ "category": "warranty", "subtype": "electronics|appliance|vehicle|home|other", "description": "what is covered", "provider": "warranty provider name", "renewalDate": "YYYY-MM-DD — expiry date or null", "amount": "cost if known or null", "consequence": "no coverage if expires", "confidence": "high|medium|low" }
Return the item whenever you can identify BOTH a provider AND an expiry date, even at low confidence. Drop only if either is missing or the email is purely promotional.`,
  },
  {
    key: "registrations",
    // Common registrars (GoDaddy/Namecheap/Cloudflare/etc.) added by
    // name because "Your GoDaddy Renewal Notice" doesn't contain any
    // of the generic keywords — the brand IS the category signal.
    query:
      `subject:(registration OR license OR passport OR lease OR domain OR permit OR ` +
      `"drivers license" OR "vehicle registration" OR "business license" OR ` +
      `GoDaddy OR Namecheap OR Cloudflare OR "expiration notice" OR ` +
      `"renewal reminder" OR "renewal notice")`,
    instructions: `Extract registration, license, or legal document expiration. Return JSON or null:
{ "category": "registration", "subtype": "vehicle|drivers_license|passport|lease|domain|business|other", "description": "what needs renewing", "provider": "issuing authority or company", "renewalDate": "YYYY-MM-DD or null", "amount": "fee if known or null", "consequence": "lapses or illegal or service stops", "confidence": "high|medium|low" }
Return the item whenever you can identify BOTH an issuing authority/provider AND a renewal date, even at low confidence. Drop only if either is missing or the email is purely informational with no actionable expiry.`,
  },
];

// Jaccard-against-shorter word overlap, mirrors api/import.js's
// descriptionOverlap. Used by both cross-pass Rule B and the
// against-existing dedup so we catch cases like "Health Tech Nerds
// subscription renewal" vs "Health Tech Nerds Membership - Monthly
// subscription renewal" — exact match misses them; substring-includes
// misses them too because of the middle phrase; word overlap is 1.0.
// Generic English stopwords PLUS vault-structural words. The structural
// set — "insurance", "policy", "renewal", "subscription" etc. — appears
// in nearly every vault description and would inflate overlap when
// comparing distinct items (e.g. "HO3 Home insurance policy renewal" vs
// "Personal Flood insurance policy renewal" share 3 of 5 words without
// these). Removing them isolates the distinguishing tokens.
const VAULT_OVERLAP_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "your", "this", "that",
  "you", "are", "was", "will", "has", "have", "been",
  "insurance", "policy", "renewal", "renews", "subscription",
  "membership", "registration", "warranty", "expiration", "expires",
  "service", "plan", "notice", "reminder",
]);

function vaultDescriptionOverlap(a, b) {
  if (!a || !b) return 0;
  const toWords = (s) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !VAULT_OVERLAP_STOPWORDS.has(w))
    );
  const wordsA = toWords(a);
  const wordsB = toWords(b);
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let common = 0;
  for (const w of wordsA) if (wordsB.has(w)) common++;
  return common / Math.min(wordsA.size, wordsB.size);
}

// "How rich is this item" for tie-breaking when descriptions match
// within Rule B's 7-day window. Confidence is broken out separately
// (Rule A uses it directly).
function vaultInfoDensity(item) {
  let n = 0;
  if (item.description) n++;
  if (item.provider) n++;
  if (item.renewalDate) n++;
  if (item.amount) n++;
  if (item.consequence) n++;
  if (item.policyNumber) n++;
  if (item.frequency) n++;
  if (item.subtype) n++;
  return n;
}

function vaultConfidenceRank(c) {
  if (c === "high") return 3;
  if (c === "medium") return 2;
  if (c === "low") return 1;
  return 0;
}

// Cross-pass dedup. Two rules per spec:
//   A. Same provider + subtype + renewalDate within 30 days → keep higher
//      confidence.
//   B. Description word-overlap > 0.5 + renewalDate within 7 days → keep
//      richer (info density count).
// Greedy: walk the input list once; for each item, check it against
// already-kept items. On match, decide which to keep based on the matching
// rule; the loser is discarded.
function dedupVaultItemsAcrossPasses(items) {
  const kept = [];
  const SEVEN_DAYS_MS = 7 * DAY_MS;
  const THIRTY_DAYS_MS = 30 * DAY_MS;
  for (const item of items) {
    let dupIndex = -1;
    let dupRule = null;
    for (let i = 0; i < kept.length; i++) {
      const ex = kept[i];
      const itemMs = item.renewalDate ? Date.parse(item.renewalDate) : NaN;
      const exMs = ex.renewalDate ? Date.parse(ex.renewalDate) : NaN;
      const datesParseable = !isNaN(itemMs) && !isNaN(exMs);

      // Rule A — provider + subtype + 30-day window
      const newProvider = (item.provider || "").toLowerCase().trim();
      const exProvider = (ex.provider || "").toLowerCase().trim();
      if (
        newProvider && exProvider && newProvider === exProvider &&
        item.subtype && ex.subtype && item.subtype === ex.subtype &&
        datesParseable && Math.abs(itemMs - exMs) <= THIRTY_DAYS_MS
      ) {
        dupIndex = i;
        dupRule = "A";
        break;
      }

      // Rule B — description word-overlap > 0.5 + 7-day window
      if (
        datesParseable && Math.abs(itemMs - exMs) <= SEVEN_DAYS_MS &&
        vaultDescriptionOverlap(item.description, ex.description) > 0.5
      ) {
        dupIndex = i;
        dupRule = "B";
        break;
      }
    }

    if (dupIndex === -1) {
      kept.push(item);
    } else {
      const existing = kept[dupIndex];
      const newWins = dupRule === "A"
        ? vaultConfidenceRank(item.confidence) > vaultConfidenceRank(existing.confidence)
        : vaultInfoDensity(item) > vaultInfoDensity(existing);
      if (newWins) kept[dupIndex] = item;
    }
  }
  return kept;
}

// Runs one of the five vault passes. Each pass: gmailSearch → metadata fetch
// → per-email Claude calls in batches of 10. Returns the parsed items array
// (filtered for parseability + renewalDate present, but NOT yet cross-pass
// or against-existing dedup'd — that happens in runVaultJob).
async function runVaultPass(accessToken, pass, afterEpoch) {
  const query = `after:${afterEpoch} ${pass.query}`;
  const messageIds = await gmailSearch(accessToken, query, 50).catch(() => []);
  if (messageIds.length === 0) return { items: [], scanned: 0 };

  const headers = [];
  for (let i = 0; i < messageIds.length; i += 15) {
    const chunk = messageIds.slice(i, i + 15);
    const chunkResults = await Promise.all(
      chunk.map((id) => fetchEmailFullBody(accessToken, id).catch(() => null))
    );
    headers.push(...chunkResults);
  }
  const validHeaders = headers.filter(Boolean);

  const items = [];
  const tally = { claudeEmpty: 0, noRenewalDate: 0, dateUnparseable: 0, dateTooOld: 0, kept: 0 };
  const PARALLEL = 10;
  for (let i = 0; i < validHeaders.length; i += PARALLEL) {
    const batch = validHeaders.slice(i, i + PARALLEL);
    const parsed = await Promise.all(
      batch.map(async (e) => {
        // Snippet first (Gmail's content-aware preview — often carries
        // the policy/provider name in clean form), then the readable
        // body. Body is capped to keep Claude input bounded; 2500
        // chars is enough to capture the renewal details block in
        // typical commercial mail.
        const bodyExcerpt = (e.body || "").substring(0, 2500);
        const promptText = `${pass.instructions}

Email:
Subject: ${e.subject}
From: ${e.from}
Date: ${e.date}
Snippet: ${e.snippet || ""}
Body:
${bodyExcerpt}`;
        const text = await callClaude(promptText, 300).catch(() => null);
        return safeParseJsonText(text);
      })
    );
    for (let j = 0; j < parsed.length; j++) {
      const item = parsed[j];
      const subj = (batch[j].subject || "").substring(0, 60);
      if (!item || typeof item !== "object") {
        tally.claudeEmpty++;
        console.log(`[vault:${pass.key}] drop claudeEmpty: "${subj}"`);
        continue;
      }
      if (!item.renewalDate) {
        tally.noRenewalDate++;
        console.log(`[vault:${pass.key}] drop noRenewalDate: "${subj}"`);
        continue;
      }
      const ms = Date.parse(item.renewalDate);
      // Match the most permissive prompt's window (insurance: 60 days
      // past). Items past that are universally stale enough to drop
      // server-side regardless of which pass surfaced them.
      if (isNaN(ms)) {
        tally.dateUnparseable++;
        console.log(`[vault:${pass.key}] drop dateUnparseable (renewalDate=${item.renewalDate}): "${subj}"`);
        continue;
      }
      if (ms < Date.now() - 60 * DAY_MS) {
        tally.dateTooOld++;
        console.log(`[vault:${pass.key}] drop dateTooOld (renewalDate=${item.renewalDate}): "${subj}"`);
        continue;
      }
      tally.kept++;
      items.push(item);
    }
  }
  console.log(`[vault:${pass.key}] complete scanned=${validHeaders.length} claudeEmpty=${tally.claudeEmpty} noRenewalDate=${tally.noRenewalDate} dateUnparseable=${tally.dateUnparseable} dateTooOld=${tally.dateTooOld} kept=${tally.kept}`);
  return { items, scanned: validHeaders.length };
}

async function runVaultJob(userId, householdId) {
  await patchJob(householdId, "vault", { state: "running", startedAt: Date.now() });

  const accessToken = await getValidToken(userId);
  const twelveMonthsAgo = Math.floor((Date.now() - 365 * DAY_MS) / 1000);

  // Fire all five passes in parallel. Per-pass errors fall through to []
  // so one bad query doesn't blow up the whole job.
  const passResults = await Promise.all(
    VAULT_PASSES.map((pass) =>
      runVaultPass(accessToken, pass, twelveMonthsAgo).catch((err) => {
        console.warn(`Vault pass ${pass.key} failed:`, err.message);
        return { items: [], scanned: 0 };
      })
    )
  );

  // Per-pass visibility for the onboard-status dashboard.
  const passCounts = VAULT_PASSES.map((p, i) => ({
    key: p.key,
    scanned: passResults[i].scanned,
    extracted: passResults[i].items.length,
  }));
  await patchJob(householdId, "vault", { passCounts });

  // Cross-pass dedup before checking against the existing vault. Items
  // that overlap between passes (e.g., a State Farm policy renewal email
  // that hits both INSURANCE and REGISTRATIONS subject filters) collapse
  // to one record here.
  const allItems = passResults.flatMap((r) => r.items);
  const crossDedup = dedupVaultItemsAcrossPasses(allItems);

  // Against-existing dedup: word-overlap > 0.5 + renewalDate within
  // 30 days. Catches re-imports of the same renewal across onboard runs
  // even when descriptions diverge slightly (e.g. "Health Tech Nerds
  // subscription renewal" vs "Health Tech Nerds Membership - Monthly
  // subscription renewal"). 30-day window protects against deduping
  // across years for repeating annual renewals.
  const existingRaw = await redis.lrange(`household:${householdId}:vault`, 0, -1);
  const THIRTY_DAYS_MS = 30 * DAY_MS;
  const existingItems = existingRaw.map(safeJson).filter(Boolean);
  function isDuplicateItem(item) {
    const desc = item.description || "";
    if (!desc) return true;
    const itemMs = item.renewalDate ? Date.parse(item.renewalDate) : NaN;
    if (isNaN(itemMs)) return false;
    for (const ex of existingItems) {
      const exMs = ex.renewalDate ? Date.parse(ex.renewalDate) : NaN;
      if (isNaN(exMs) || Math.abs(itemMs - exMs) > THIRTY_DAYS_MS) continue;
      if (vaultDescriptionOverlap(desc, ex.description) > 0.5) return true;
    }
    return false;
  }

  let kept = 0;
  for (const item of crossDedup) {
    if (isDuplicateItem(item)) continue;
    existingItems.push(item);

    await redis.lpush(
      `household:${householdId}:vault`,
      JSON.stringify({
        id: `vault_${Date.now()}_${kept}`,
        category: item.category || "other",
        subtype: item.subtype || null,
        description: item.description,
        provider: item.provider || null,
        renewalDate: item.renewalDate,
        amount: item.amount || null,
        policyNumber: item.policyNumber || null,
        frequency: item.frequency || null,
        consequence: item.consequence || null,
        confidence: item.confidence || "low",
        source: "gmail",
        foundAt: Date.now(),
      })
    );
    kept++;
  }

  const processed = allItems.length;
  const dropped = processed - kept;

  await patchJob(householdId, "vault", {
    state: "complete",
    finishedAt: Date.now(),
    passCounts,
    processed,
    kept,
    dropped,
  });
  return { processed, kept, dropped };
}

// ---------- Job 4: Crew sweep ----------
//
// Children + pets layer. Surveys the last 12 months of email for
// activity registrations, school comms, vet/grooming appointments,
// and parent-app notifications (ClassDojo, Brightwheel, Remind). Per-
// batch Claude extraction returns structured child/pet records that
// get merged across batches by member name, then merged again into
// any existing :crew record so a single missed onboard doesn't lose
// previously-found members.

async function runCrewJob(userId, householdId) {
  await patchJob(householdId, "crew", { state: "running", startedAt: Date.now() });

  const accessToken = await getValidToken(userId);
  const twelveMonthsAgo = Math.floor((Date.now() - 365 * DAY_MS) / 1000);

  const query =
    `after:${twelveMonthsAgo} subject:(soccer OR baseball OR basketball OR swim OR ` +
    `dance OR piano OR guitar OR violin OR lessons OR practice OR game OR recital OR ` +
    `"school" OR "pickup" OR pediatric OR vet OR veterinary OR grooming OR ` +
    `ClassDojo OR Brightwheel OR Remind OR "parent teacher" OR "field trip" OR ` +
    `tutor OR karate OR gymnastics OR lacrosse OR hockey OR tennis OR ` +
    `"after school" OR "day care" OR daycare OR preschool)`;

  const messageIds = await gmailSearch(accessToken, query, 100).catch(() => []);
  await patchJob(householdId, "crew", { found: messageIds.length });

  if (messageIds.length === 0) {
    await patchJob(householdId, "crew", {
      state: "complete",
      finishedAt: Date.now(),
      processed: 0,
      members: 0,
    });
    return { processed: 0, members: 0 };
  }

  // Same parallel-chunk-of-15 pattern as the email + vault jobs.
  const headers = [];
  for (let i = 0; i < messageIds.length; i += 15) {
    const chunk = messageIds.slice(i, i + 15);
    const chunkResults = await Promise.all(
      chunk.map((id) => fetchEmailMetadata(accessToken, id).catch(() => null))
    );
    headers.push(...chunkResults);
  }
  const validHeaders = headers.filter(Boolean);

  // Load any existing crew so a fresh run merges into rather than
  // overwrites prior findings. Crew is stored as a single JSON string
  // (not a list) so a get + JSON.parse is sufficient.
  const existingRaw = await redis.get(`household:${householdId}:crew`);
  const existing = safeJson(existingRaw);
  const startingCrew = Array.isArray(existing) ? existing : [];

  // Dedup map: key = "{memberType}:{lowercase name}". Unkeyed (no
  // name) items go to a separate bucket and are only kept if they
  // carry useful detail — otherwise they'd surface as phantom
  // "Child" entries cluttering the screen.
  const crewByKey = new Map();
  const unkeyed = [];

  function mergeArrays(a, b, dedupKey) {
    const seen = new Set();
    const result = [];
    for (const item of [...(a || []), ...(b || [])]) {
      if (!item || typeof item !== "object") continue;
      const k = (item[dedupKey] || "").toLowerCase().trim();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      result.push(item);
    }
    return result;
  }

  function ingest(item) {
    if (!item || !item.memberType) return;
    if (item.memberType !== "child" && item.memberType !== "pet") return;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!name) {
      const hasDetail =
        (item.activities && item.activities.length > 0) ||
        (item.upcomingEvents && item.upcomingEvents.length > 0) ||
        item.school ||
        item.vet;
      if (hasDetail) unkeyed.push(item);
      return;
    }
    const key = `${item.memberType}:${name.toLowerCase()}`;
    const existing = crewByKey.get(key);
    if (!existing) {
      crewByKey.set(key, { ...item, name });
      return;
    }
    // Merge: scalar fields prefer first-seen non-null; array fields
    // concatenate with dedup by their natural key.
    existing.age = existing.age ?? item.age;
    existing.breed = existing.breed ?? item.breed;
    existing.type = existing.type ?? item.type;
    existing.school = existing.school ?? item.school;
    existing.vet = existing.vet ?? item.vet;
    existing.activities = mergeArrays(existing.activities, item.activities, "name");
    existing.upcomingEvents = mergeArrays(existing.upcomingEvents, item.upcomingEvents, "description");
  }

  // Seed the dedup map with the existing :crew contents so this run
  // merges into them.
  for (const item of startingCrew) ingest(item);

  let processed = 0;
  const PARALLEL = 10;

  for (let i = 0; i < validHeaders.length; i += PARALLEL) {
    const batch = validHeaders.slice(i, i + PARALLEL);
    const emailsList = batch
      .map((e, idx) => `${idx + 1}. Subject: ${e.subject}\n   From: ${e.from}`)
      .join("\n");

    const prompt = `Analyze these emails and extract any information about children or pets in this household. Return a JSON array of found items or empty array:

For children:
{
  "memberType": "child",
  "name": string | null,
  "age": number | null,
  "activities": [{ "name": string, "schedule": string, "location": string }],
  "school": { "name": string, "pickupTime": string } | null,
  "upcomingEvents": [{ "description": string, "date": string }]
}

For pets:
{
  "memberType": "pet",
  "name": string | null,
  "type": "dog" | "cat" | "other",
  "breed": string | null,
  "vet": { "name": string, "phone": string } | null,
  "upcomingEvents": [{ "description": string, "date": string }]
}

Look for any indication of children or pets. Even indirect signals count — a school newsletter, a vet bill receipt, a sports registration confirmation, a daycare invoice. Extract whatever you can find even if incomplete. A child's first name alone is worth capturing.

Return a crew member if you have at least a name OR a recurring activity. Return empty array only if you genuinely find no children/pets references.
Return ONLY the JSON array, nothing else.

Emails:
${emailsList}`;

    try {
      const text = await callClaude(prompt, 1500);
      const items = safeParseJsonText(text);
      if (Array.isArray(items)) {
        for (const item of items) ingest(item);
      }
    } catch (err) {
      console.warn("Crew batch failed:", err.message);
    }

    processed += batch.length;
    await patchJob(householdId, "crew", {
      processed,
      members: crewByKey.size + unkeyed.length,
    });
  }

  const crew = [...crewByKey.values(), ...unkeyed];

  // Single-key string write; consumers parse JSON on read.
  if (crew.length > 0) {
    await redis.set(`household:${householdId}:crew`, JSON.stringify(crew));
  }

  await patchJob(householdId, "crew", {
    state: "complete",
    finishedAt: Date.now(),
    processed,
    members: crew.length,
  });

  return { processed, members: crew.length };
}

// ---------- Job 5: Horizon selection ----------

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

// Per-job dispatcher. /api/onboard fans out 4 parallel QStash messages
// (emails, calendar, vault, crew). horizon is chained off vault here so
// it runs after :vault is populated. Each invocation gets its own 60s
// budget — the 5-jobs-in-60s squeeze of the prior monolithic handler is
// gone.
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

  const { userId, householdId, job } = body;
  if (!userId || !householdId) {
    return res.status(400).json({ error: "Missing userId or householdId" });
  }
  if (!job || !ALL_JOBS.includes(job)) {
    return res.status(400).json({ error: "Missing or invalid job" });
  }

  // Top-level state flips to "running" on the first per-job invocation.
  // Idempotent — repeated HSET is fine.
  await redis.hset(statusKey(householdId), { state: "running" });

  let failed = false;
  try {
    if (job === "emails") await runEmailJob(userId, householdId);
    else if (job === "calendar") await runCalendarJob(userId, householdId);
    else if (job === "vault") await runVaultJob(userId, householdId);
    else if (job === "crew") await runCrewJob(userId, householdId);
    else if (job === "horizon") await runHorizonJob(householdId);
  } catch (err) {
    console.error(`${job} job failed:`, err);
    await patchJob(householdId, job, {
      state: "failed",
      error: err.message,
      finishedAt: Date.now(),
    });
    failed = true;
  }

  // Chain horizon after vault: on success enqueue it, on failure mark it
  // skipped so the overall onboard can still finalize. Horizon reads
  // :vault, so it must not run if vault didn't populate.
  if (job === "vault") {
    if (failed) {
      await patchJob(householdId, "horizon", {
        state: "skipped",
        reason: "vault failed",
        finishedAt: Date.now(),
      });
    } else {
      await enqueueJob({ userId, householdId, job: "horizon" });
    }
  }

  await maybeFinalize(householdId);

  return res.status(200).json({ ok: true, job });
}
