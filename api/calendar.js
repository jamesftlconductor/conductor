import { Redis } from "@upstash/redis";
import { getValidToken } from "./refresh.js";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Mirrored from api/onboard-worker.js — keep in sync. Both paths share
// calendar-import semantics; duplicating here avoids cross-importing
// onboard-worker from a daily-sync endpoint.
const CONSUMER_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com",
  "yahoo.com", "yahoo.co.uk", "ymail.com",
  "hotmail.com", "outlook.com", "live.com", "msn.com",
  "icloud.com", "me.com", "mac.com",
  "aol.com", "protonmail.com", "proton.me",
]);

function isWorkCalendar(cal, userEmail, userWorkCalendarName) {
  const summary = (cal?.summary || "").toLowerCase();
  if (/\b(work|office)\b/.test(summary)) return true;
  // User-supplied calendar name from Settings (case-insensitive whole-word
  // match). Lets users tag a non-default calendar like "Day Job" or
  // "Consulting" as work without it having to literally contain "work".
  if (userWorkCalendarName && summary === userWorkCalendarName.toLowerCase().trim()) {
    return true;
  }
  if (cal?.primary === true && userEmail) {
    const domain = userEmail.split("@")[1]?.toLowerCase();
    if (domain && !CONSUMER_EMAIL_DOMAINS.has(domain)) return true;
  }
  return false;
}

// Privacy guarantee: work calendar events store ONLY time-block fields,
// never title/description/attendees/location/calendar-name/eventType.
// Conductor knows you're busy, never knows why or with whom. Conflict
// detector reads `start`/`end` ISO strings (kept here as derivative time
// data, not content) plus the structured date/startTime/endTime fields.
function stripToTimeBlock(event, classifiedBy) {
  const startIso = event.start;
  const endIso = event.end;
  const d = startIso ? new Date(startIso) : null;
  const endD = endIso ? new Date(endIso) : null;
  const pad = (n) => String(n).padStart(2, "0");
  const date = d
    ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    : null;
  const startTime = d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : null;
  const endTime = endD ? `${pad(endD.getHours())}:${pad(endD.getMinutes())}` : null;
  const dayOfWeek = d
    ? ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getDay()]
    : null;
  return {
    // Synthetic id from the time block — opaque, content-free, stable
    // across syncs for the same slot. Google's event.id is intentionally
    // dropped so we never persist anything tied to the original record.
    id: `work_${date || "unknown"}_${startTime || "00:00"}_${endTime || "00:00"}`,
    type: "work",
    source: "work",
    isBlocking: true,
    workConflictCheck: true,
    householdRelevant: false,
    date,
    startTime,
    endTime,
    dayOfWeek,
    // Derivative ISO timestamps for the conflict detector (brief.js
    // memberBlockedInWindow uses these via parseDateLoose).
    start: startIso || null,
    end: endIso || null,
    userId: event.userId,
    classifiedBy,
  };
}

export async function runCalendarSync(userId) {
  if (!userId) throw new Error("No userId provided");

  // Resolve household first so we can check the per-household sync cooldown.
  const hidEarly = await redis.get(`user:${userId}:household`);
  const householdEarly = hidEarly || userId;

  // Skip if THIS USER synced within the last 23 hours. Per-user cooldown
  // (instead of per-household) — under multi-driver sync, members run
  // their own runCalendarSync independently and shouldn't block each
  // other on a shared stamp. Reads the legacy household-level stamp as
  // a one-time fallback so post-deploy syncs don't all double-fire.
  let lastSyncRaw = await redis.get(`user:${userId}:calendarLastSync`);
  if (lastSyncRaw == null) {
    lastSyncRaw = await redis.get(`household:${householdEarly}:calendarLastSync`);
  }
  const lastSync = lastSyncRaw
    ? (typeof lastSyncRaw === "number" ? lastSyncRaw : parseInt(lastSyncRaw, 10))
    : 0;
  const TWENTY_THREE_HOURS_MS = 23 * 60 * 60 * 1000;
  if (lastSync && Date.now() - lastSync < TWENTY_THREE_HOURS_MS) {
    return {
      skipped: true,
      reason: "synced recently",
      household: householdEarly,
      userId,
      lastSync,
    };
  }

  const accessToken = await getValidToken(userId);

  // Resolve user email so the Workspace-primary heuristic in
  // isWorkCalendar can fire. Best-effort.
  let userEmail = null;
  try {
    const profileRaw = await redis.get(`user:${userId}:profile`);
    const profile = typeof profileRaw === "string" ? JSON.parse(profileRaw) : profileRaw;
    userEmail = profile?.email || null;
  } catch {
    // ignored
  }

  // Resolve the user-supplied work-calendar name from preferences so
  // isWorkCalendar can match calendars whose names don't include
  // "work"/"office" but the user has tagged as their work calendar.
  let userWorkCalendarName = null;
  try {
    const prefsRaw = await redis.get(`user:${userId}:preferences`);
    const prefs = typeof prefsRaw === "string" ? JSON.parse(prefsRaw) : prefsRaw;
    userWorkCalendarName = prefs?.workCalendarName || null;
  } catch {
    // ignored
  }
  console.log(
    `[calendar] sync for ${userId}: workCalendarName=${JSON.stringify(userWorkCalendarName)}`
  );

  const now = new Date();
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysAhead = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

  // Get all calendars
  const calListResponse = await fetch(
    "https://www.googleapis.com/calendar/v3/users/me/calendarList",
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const calListData = await calListResponse.json();
  const calendars = calListData.items || [];

  // Identify work calendars from metadata before fetching events.
  const workCalendarIds = new Set();
  for (const cal of calendars) {
    if (isWorkCalendar(cal, userEmail, userWorkCalendarName)) workCalendarIds.add(cal.id);
  }

  let allEvents = [];

  for (const calendar of calendars) {
    try {
      const eventsResponse = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar.id)}/events?` +
        `timeMin=${encodeURIComponent(thirtyDaysAgo)}&` +
        `timeMax=${encodeURIComponent(thirtyDaysAhead)}&` +
        `singleEvents=true&orderBy=startTime&maxResults=100`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const eventsData = await eventsResponse.json();
      const events = eventsData.items || [];

      for (const event of events) {
        allEvents.push({
          id: event.id,
          title: event.summary || "Untitled",
          description: event.description || "",
          start: event.start?.dateTime || event.start?.date,
          end: event.end?.dateTime || event.end?.date,
          calendar: calendar.summary,
          calendarId: calendar.id,
          // Google's structured event-type signal — outOfOffice / focusTime
          // are explicit availability blockers regardless of source calendar.
          eventType: event.eventType || "default",
          userId,
        });
      }
    } catch (err) {
      continue;
    }
  }

  // Pre-tag structurally-known work events so they skip the LLM call.
  // Same logic as api/onboard-worker.js: events from a work calendar OR
  // events that Google itself flagged as outOfOffice/focusTime. Both
  // paths run through stripToTimeBlock so the stored record carries no
  // title/description/calendar-name — privacy by construction.
  const classified = [];
  const needsClassification = [];
  for (const ev of allEvents) {
    const fromWorkCal = workCalendarIds.has(ev.calendarId);
    const structurallyBlocking =
      ev.eventType === "outOfOffice" || ev.eventType === "focusTime";
    if (fromWorkCal || structurallyBlocking) {
      const tag = fromWorkCal ? "work-calendar" : "event-type";
      classified.push(stripToTimeBlock(ev, tag));
    } else {
      needsClassification.push(ev);
    }
  }

  for (const event of needsClassification) {
    try {
      const classifyResponse = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 50,
          messages: [{
            role: "user",
            content: `Classify this calendar event. Return ONLY a JSON object with:
- type: "household" | "work" | "personal" | "travel"
- householdRelevant: true | false
- workConflictCheck: true | false (true if this blocks the person and could conflict with household events)

Event: "${event.title}"
Calendar: "${event.calendar}"
Description: "${event.description?.substring(0, 200) || ""}"

Return only the JSON object.`,
          }],
        }),
      });

      const classifyData = await classifyResponse.json();
      const text = classifyData.content[0].text;
      const clean = text.replace(/```json|```/g, "").trim();
      const classification = JSON.parse(clean);

      // Privacy strip: if the LLM classifies an event as work (or marks
      // workConflictCheck=true), persist only the time block. The title
      // and description were sent to Claude for the classification call
      // itself but are dropped before storage.
      const isWorkByLLM =
        classification.type === "work" || classification.workConflictCheck === true;
      if (isWorkByLLM) {
        classified.push(stripToTimeBlock(event, "llm"));
      } else {
        classified.push({ ...event, ...classification, classifiedBy: "llm" });
      }
      await new Promise(r => setTimeout(r, 100));

    } catch (err) {
      classified.push({
        ...event,
        type: "unknown",
        householdRelevant: false,
        workConflictCheck: false,
        classifiedBy: "llm-error",
      });
    }
  }

  // Store classified events at the per-user calendar key. Each member
  // writes their own slice; consumers merge via api/calendar-loader.js
  // loadHouseholdCalendar(). The legacy household-level :calendar key
  // is intentionally NOT touched — its 30-day TTL ages it out, and
  // the loader prefers per-user keys whenever any exist.
  const householdId = householdEarly;
  await redis.set(
    `household:${householdId}:calendar:${userId}`,
    JSON.stringify(classified),
    { ex: 60 * 60 * 24 * 30 }
  );
  // Stamp per-user so each member's 23h cooldown is independent.
  await redis.set(`user:${userId}:calendarLastSync`, Date.now());

  const householdEvents = classified.filter(e => e.householdRelevant).length;
  const workEvents = classified.filter(e => e.type === "work").length;
  const preTaggedWork = classified.filter(
    e => e.classifiedBy === "work-calendar" || e.classifiedBy === "event-type"
  ).length;

  return {
    total: classified.length,
    household: householdEvents,
    work: workEvents,
    preTagged: preTaggedWork,
    workCalendars: workCalendarIds.size,
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: "No userId provided" });
  }

  try {
    const result = await runCalendarSync(userId);
    return res.status(200).json(result);
  } catch (error) {
    console.error("Calendar error:", error);
    return res.status(500).json({ error: "Calendar sync failed" });
  }
}
