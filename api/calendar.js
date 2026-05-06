import { Redis } from "@upstash/redis";
import { getValidToken } from "./refresh.js";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export async function runCalendarSync(userId) {
  if (!userId) throw new Error("No userId provided");

  // Resolve household first so we can check the per-household sync cooldown.
  const hidEarly = await redis.get(`user:${userId}:household`);
  const householdEarly = hidEarly || userId;

  // Skip if synced within the last 23 hours — prevents redundant Gmail/Calendar
  // API hits + Claude classifications when the endpoint is called repeatedly.
  const lastSyncRaw = await redis.get(`household:${householdEarly}:calendarLastSync`);
  const lastSync = lastSyncRaw
    ? (typeof lastSyncRaw === "number" ? lastSyncRaw : parseInt(lastSyncRaw, 10))
    : 0;
  const TWENTY_THREE_HOURS_MS = 23 * 60 * 60 * 1000;
  if (lastSync && Date.now() - lastSync < TWENTY_THREE_HOURS_MS) {
    return {
      skipped: true,
      reason: "synced recently",
      household: householdEarly,
      lastSync,
    };
  }

  const accessToken = await getValidToken(userId);

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
          userId,
        });
      }
    } catch (err) {
      continue;
    }
  }

  // Classify events with Claude
  const classified = [];

  for (const event of allEvents) {
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

      classified.push({ ...event, ...classification });
      await new Promise(r => setTimeout(r, 100));

    } catch (err) {
      classified.push({ ...event, type: "unknown", householdRelevant: false, workConflictCheck: false });
    }
  }

  // Store classified events
  const householdId = householdEarly;
  await redis.set(
    `household:${householdId}:calendar`,
    JSON.stringify(classified),
    { ex: 60 * 60 * 24 }
  );
  // Stamp the sync time so subsequent calls within 23h skip the work.
  await redis.set(`household:${householdId}:calendarLastSync`, Date.now());

  const householdEvents = classified.filter(e => e.householdRelevant).length;
  const workEvents = classified.filter(e => e.type === "work").length;

  return {
    total: classified.length,
    household: householdEvents,
    work: workEvents,
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
