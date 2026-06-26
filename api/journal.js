// Journal — the weekly reflective entry surface. Three roles in one route:
//
//   GET  /api/journal?userId=&householdId=        → last 12 entries
//   POST /api/journal   { userId, householdId, entryId, response }
//                                                  → store a user response
//   GET/POST /api/journal?action=generate         → generate this week's entry
//        (per-household when householdId/userId given; otherwise iterates all
//         households — the Sunday-evening cron path). Skips non-Sunday unless
//         ?force=1.
//
// Storage:
//   household:{id}:journal            LIST of { id, date, text, question, weekNumber }
//   household:{id}:journal:responses  LIST of { entryId, response, userId, at }

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const DAY_MS = 24 * 60 * 60 * 1000;
const safeJson = (v) => { try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return null; } };

async function resolveHouseholdId(userId) {
  if (!userId) return null;
  return (await redis.get(`user:${userId}:household`)) || userId;
}

function isoWeek(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((date - firstThursday) / DAY_MS - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
}

// ---------- generation ----------

async function callHaiku(prompt, maxTokens = 400) {
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
      tools: [{
        name: "record_journal_entry",
        description: "Record the week's journal entry text and the single plain weekly question.",
        input_schema: {
          type: "object",
          properties: {
            text: { type: "string", description: "the reflective entry" },
            question: { type: "string", description: "one plain question, no preamble" },
          },
          required: ["text", "question"],
        },
      }],
      tool_choice: { type: "tool", name: "record_journal_entry" },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!r.ok) return null;
  const data = await r.json();
  const tool = (data?.content || []).find((b) => b?.type === "tool_use");
  return tool?.input || null;
}

export async function generateJournalEntry(householdId) {
  const cutoff = Date.now() - 90 * DAY_MS;
  const [rawMemory, rawPatterns, rawJournal, rawResponses, rawSignals] = await Promise.all([
    redis.lrange(`household:${householdId}:memory`, 0, 299).catch(() => []),
    redis.lrange(`household:${householdId}:patterns`, 0, 49).catch(() => []),
    redis.lrange(`household:${householdId}:journal`, 0, 5).catch(() => []),
    redis.lrange(`household:${householdId}:journal:responses`, 0, 9).catch(() => []),
    redis.lrange(`household:${householdId}:signals`, 0, 199).catch(() => []),
  ]);

  const memory = (rawMemory || []).map(safeJson).filter(Boolean)
    .filter((e) => (Date.parse(e.actionAt || "") || 0) >= cutoff);
  const resolved = memory.filter((e) => e.action === "resolved");
  const patterns = (rawPatterns || []).map(safeJson).filter(Boolean);
  const prevEntries = (rawJournal || []).map(safeJson).filter(Boolean);
  const responses = (rawResponses || []).map(safeJson).filter(Boolean);
  const signals = (rawSignals || []).map(safeJson).filter(Boolean);
  const active = signals.filter((s) => !s.state || s.state === "incoming" || s.state === "active");
  const grief = active.find((s) => s.emotionalValence === "grief");
  const milestone = active.find((s) => s.emotionalValence === "joyful" && s.emotionalIntensity === "high");

  // Significant events from the 90d resolution log + active signals.
  const trips = signals.filter((s) => s.type === "travel").slice(0, 3).map((s) => s.description);
  const recentResolved = resolved.slice(0, 8).map((e) => e.description).filter(Boolean);

  const prevBlock = prevEntries.length
    ? prevEntries.slice(0, 3).map((e) => `- "${(e.text || "").slice(0, 120)}"${e.question ? ` (asked: "${e.question}")` : ""}`).join("\n")
    : "(no prior entries)";
  const respBlock = responses.length
    ? responses.slice(0, 3).map((r) => `- "${(r.response || "").slice(0, 120)}"`).join("\n")
    : "(no responses yet)";

  const prompt = `You write a household's weekly journal entry. It reflects THE HOUSEHOLD back to itself — never about you, the writer.

This week's material:
- Signals resolved in the last 90 days: ${resolved.length}${recentResolved.length ? ` (recent: ${recentResolved.slice(0, 5).join("; ")})` : ""}
- Currently open: ${active.length}
- Behavioral patterns: ${patterns.slice(0, 4).map((p) => p.description).filter(Boolean).join("; ") || "none yet"}
- Travel/trips on the radar: ${trips.join("; ") || "none"}
- Emotional undercurrent: ${grief ? "grief present" : milestone ? "a milestone" : "ordinary"}
Recent prior entries (reference naturally ONLY if it fits):
${prevBlock}
Recent reader responses:
${respBlock}

Voice rules — follow exactly:
- Observational and warm. Reflect the household, not yourself.
- NEVER say "I noticed", "I watched", "I saw", "I've been", or refer to yourself at all.
- Sometimes end mid-thought. Sometimes be very short — a single sentence, or even one word, is allowed when that's truer than more.
- Don't summarize like a report. No "this week you…". Let it be a thought, not a recap.
- Reference a past entry or response only when it genuinely connects; otherwise don't force it.

Then write ONE weekly question — plain, direct, no preamble (not "I was wondering…"). It should be answerable in a sentence.

Return via the tool: { text, question }.`;

  const out = await callHaiku(prompt, 400);
  if (!out || !out.text) return null;

  const entry = {
    id: Date.now(),
    date: new Date().toISOString(),
    text: String(out.text).trim(),
    question: out.question ? String(out.question).trim() : null,
    weekNumber: isoWeek(),
  };
  await redis.lpush(`household:${householdId}:journal`, JSON.stringify(entry));
  await redis.ltrim(`household:${householdId}:journal`, 0, 51); // keep ~1 year
  console.log(`[journal] generated entry for ${householdId} (week ${entry.weekNumber})`);
  return entry;
}

// ---------- handler ----------

export const config = { maxDuration: 30 };

async function handleGenerate(req, res) {
  const force = req.query?.force === "1" || req.query?.force === "true";
  // Sunday only (household-local / ET), unless forced. The cron fires at
  // 02:00 UTC Monday = ~Sunday 9-10pm ET, so the ET weekday is Sunday then.
  const etDay = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short" });
  if (!force && etDay !== "Sun") {
    return res.status(200).json({ ok: true, skipped: `not sunday (ET ${etDay})` });
  }
  const userId = req.query?.userId || req.body?.userId;
  let households = [];
  if (userId || req.query?.householdId) {
    const hid = req.query?.householdId || (await resolveHouseholdId(userId));
    if (hid) households = [hid];
  } else {
    // Cron path — iterate every household.
    let cursor = "0";
    do {
      const [next, batch] = await redis.scan(cursor, { match: "household:*:signals", count: 200 });
      cursor = next;
      for (const k of batch || []) {
        const m = k.match(/^household:(.+):signals$/);
        if (m) households.push(m[1]);
      }
    } while (cursor !== "0" && cursor !== 0);
  }
  const generated = [];
  for (const hid of households) {
    try {
      const entry = await generateJournalEntry(hid);
      if (entry) generated.push({ householdId: hid, weekNumber: entry.weekNumber });
    } catch (err) {
      console.warn(`[journal] generate failed for ${hid}:`, err?.message || err);
    }
  }
  return res.status(200).json({ ok: true, generated: generated.length, households: generated });
}

export default async function handler(req, res) {
  const action = req.query?.action || req.body?.action;
  if (action === "generate") return handleGenerate(req, res);

  if (req.method === "GET") {
    const userId = req.query?.userId;
    const householdId = req.query?.householdId || (await resolveHouseholdId(userId));
    if (!householdId) return res.status(400).json({ error: "householdId or userId required" });
    const raw = await redis.lrange(`household:${householdId}:journal`, 0, 11);
    const entries = (raw || []).map(safeJson).filter(Boolean);
    return res.status(200).json({ householdId, entries });
  }

  if (req.method === "POST") {
    // Store a user response to an entry (this is the /api/journal/response path,
    // collapsed onto POST /api/journal to fit the single-file route style).
    const { userId, entryId, response } = req.body || {};
    const householdId = req.body?.householdId || (await resolveHouseholdId(userId));
    if (!householdId) return res.status(400).json({ error: "householdId or userId required" });
    if (entryId === undefined || entryId === null) return res.status(400).json({ error: "entryId required" });
    if (!response || typeof response !== "string") return res.status(400).json({ error: "response required" });
    const record = { entryId, response: response.trim(), userId: userId || null, at: new Date().toISOString() };
    await redis.lpush(`household:${householdId}:journal:responses`, JSON.stringify(record));
    await redis.ltrim(`household:${householdId}:journal:responses`, 0, 199);
    return res.status(200).json({ ok: true, householdId, stored: record });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
