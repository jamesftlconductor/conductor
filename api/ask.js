// Ask Conductor — POST /api/ask. The user-facing Q&A interface for the
// household. Loads the full context picture in parallel (signals, vault,
// crew, health, weather, calendar, recent memory) and asks Claude
// Sonnet for a max-3-sentence answer grounded in what Conductor
// actually knows. SHA256-keyed 30min cache on (userId, question) so
// rapid repeated taps share a single Claude call.

import { createHash } from "node:crypto";
import { Redis } from "@upstash/redis";
import { loadHouseholdCalendar } from "./calendar-loader.js";
import { loadHouseholdLocation, LOCATION_FALLBACK } from "./location.js";
import { renderPricingForPrompt } from "./pricing.js";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export const config = { maxDuration: 30 };

const ASK_TTL_S = 30 * 60;
// Spec called for claude-sonnet-4-20250514, but that ID returns
// not_found_error from the Anthropic API — the current Sonnet 4 family
// id is claude-sonnet-4-6. Swap to the live one so questions actually
// answer.
const ASK_MODEL = "claude-sonnet-4-6";

// Per-household weather coords come from household:{id}:location now —
// see fetchWeather below. The constants are only used as fallback when
// detection failed entirely.
const WEATHER_TIMEOUT_MS = 3000;

const DAY_MS = 24 * 60 * 60 * 1000;

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

// Best-effort weather pull. Returns null on any failure so the
// question still gets answered without weather context.
async function fetchWeather(location) {
  const lat = location?.lat ?? LOCATION_FALLBACK.lat;
  const lon = location?.lon ?? LOCATION_FALLBACK.lon;
  const timezone = location?.timezone ?? LOCATION_FALLBACK.timezone;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), WEATHER_TIMEOUT_MS);
    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,relative_humidity_2m,precipitation,weathercode` +
      `&temperature_unit=fahrenheit` +
      `&timezone=${encodeURIComponent(timezone)}`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = await res.json();
    const current = data?.current;
    if (!current || typeof current.temperature_2m !== "number") return null;
    return {
      tempF: Math.round(current.temperature_2m),
      humidity: typeof current.relative_humidity_2m === "number"
        ? Math.round(current.relative_humidity_2m) : null,
      weatherCode: current.weathercode ?? 0,
    };
  } catch (err) {
    console.error("[ask] weather fetch failed:", err?.message || err);
    return null;
  }
}

function weatherSummary(w) {
  if (!w) return "Unknown";
  const { tempF, humidity, weatherCode } = w;
  let condition;
  if (weatherCode <= 1) condition = "Clear";
  else if (weatherCode <= 3) condition = "Partly cloudy";
  else if (weatherCode >= 45 && weatherCode <= 48) condition = "Foggy";
  else if (weatherCode >= 51 && weatherCode <= 67) condition = "Rain";
  else if (weatherCode >= 71 && weatherCode <= 77) condition = "Snow";
  else if (weatherCode >= 80 && weatherCode <= 82) condition = "Showers";
  else if (weatherCode >= 95 && weatherCode <= 99) condition = "Thunderstorm";
  else condition = "Mixed";
  const parts = [`${tempF}°F`, condition];
  if (humidity != null) parts.push(`${humidity}% humidity`);
  return parts.join(", ");
}

function formatSignalLine(s) {
  const desc = s.description || "Unknown";
  const eta = s.eta || "no ETA";
  const sender = s.sender ? ` from ${s.sender}` : "";
  const state = s.state || "incoming";
  return `- ${desc}${sender} | ${eta} | ${state}`;
}

function formatVaultLine(v) {
  if (v.handled) return null;
  const desc = v.description || "Unknown";
  const renewal = v.renewalDate || "no date";
  const provider = v.provider ? ` (${v.provider})` : "";
  return `- ${desc}${provider} | renews ${renewal}`;
}

function formatCrewLine(m) {
  const name = m.firstName || m.name || "Unknown";
  const role = m.memberType || "member";
  const bday = m.birthday ? ` | birthday ${m.birthday}` : "";
  const anniv = m.anniversary ? ` | anniversary ${m.anniversary}` : "";
  const events = (m.upcomingEvents || [])
    .slice(0, 2)
    .map((e) => `${e.description || "event"} on ${e.date || "?"}`)
    .join("; ");
  const eventLine = events ? ` | upcoming: ${events}` : "";
  return `- ${name} (${role})${bday}${anniv}${eventLine}`;
}

function formatHealth(health) {
  if (!health) return "Not connected";
  const parts = [];
  if (health.sleep?.duration != null) parts.push(`sleep ${health.sleep.duration}h`);
  if (health.hrv?.current != null) {
    const baseline = health.hrv.baseline7d;
    parts.push(baseline ? `HRV ${health.hrv.current} (baseline ${baseline})` : `HRV ${health.hrv.current}`);
  }
  if (health.restingHR != null) parts.push(`resting HR ${health.restingHR}`);
  if (health.steps != null) parts.push(`${health.steps} steps`);
  if (health.activeCalories != null) parts.push(`${health.activeCalories} active calories`);
  return parts.length > 0 ? parts.join(", ") : "Not connected";
}

function formatCalendarLine(ev) {
  const title = ev.title || "Untitled";
  const start = ev.start || "?";
  return `- ${title} | ${start}`;
}

function formatMemoryLine(m) {
  const desc = m.description || "Unknown";
  const action = m.action || "?";
  const when = m.actionAt || "?";
  return `- ${desc} → ${action} (${when})`;
}

async function callSonnet(systemPrompt, userPrompt) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ASK_MODEL,
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Sonnet ${response.status}: ${errText.slice(0, 200)}`);
  }
  const data = await response.json();
  return data?.content?.[0]?.text?.trim() || "";
}

// Sonnet returns a JSON object `{"answer": "...", "confidence": "high|medium|low"}`.
// Parse defensively — the model sometimes wraps in code fences or adds
// stray prose before/after. Falls back to treating the whole response as
// the answer with "medium" confidence if JSON parsing fails.
function parseAskResponse(raw) {
  if (!raw) return { answer: "", confidence: "low" };
  // Strip code fences and isolate JSON body.
  let body = raw.trim();
  body = body.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  // First {...} block — handles models that prepend a sentence.
  const match = body.match(/\{[\s\S]*\}/);
  if (match) body = match[0];
  try {
    const parsed = JSON.parse(body);
    const answer = typeof parsed.answer === "string" ? parsed.answer.trim() : "";
    const conf = typeof parsed.confidence === "string" ? parsed.confidence.toLowerCase() : "medium";
    const confidence = ["high", "medium", "low"].includes(conf) ? conf : "medium";
    if (answer.length > 0) return { answer, confidence };
  } catch { /* fall through */ }
  return { answer: raw, confidence: "medium" };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { userId, question } = req.body || {};
  if (!userId || typeof userId !== "string") {
    return res.status(400).json({ error: "Missing or invalid userId" });
  }
  if (!question || typeof question !== "string" || question.trim().length === 0) {
    return res.status(400).json({ error: "Missing or invalid question" });
  }
  const trimmedQuestion = question.trim();

  // Cache: SHA256 over (userId|question). 30min TTL means rapid repeated
  // taps share one Sonnet call; questions worded identically against the
  // same user share a cache key.
  const cacheKey = `ask:${createHash("sha256").update(`${userId}|${trimmedQuestion}`).digest("hex")}`;
  try {
    const cached = await redis.get(cacheKey);
    const parsed = safeJson(cached);
    if (parsed && typeof parsed.answer === "string" && parsed.answer.length > 0) {
      return res.status(200).json({ ...parsed, cached: true });
    }
  } catch (err) {
    console.warn("[ask] cache read failed:", err?.message || err);
  }

  try {
    const householdId = await resolveHouseholdId(userId);

    // Load location first so the weather fetch uses the household's
    // actual coordinates and the pricing context picks the right
    // market region.
    const householdLocation = (await loadHouseholdLocation(householdId)) || LOCATION_FALLBACK;

    // Parallel context pull. Each source is independently best-effort —
    // a missing piece becomes "Not available" in the prompt rather than
    // a hard failure.
    const [
      rawSignals, rawVault, rawCrew, rawHealth, weather, calendarEvents, rawMemory,
    ] = await Promise.all([
      redis.lrange(`household:${householdId}:signals`, 0, -1),
      redis.lrange(`household:${householdId}:vault`, 0, -1),
      redis.get(`household:${householdId}:crew`),
      redis.get(`user:${userId}:health`),
      fetchWeather(householdLocation),
      loadHouseholdCalendar(redis, householdId),
      redis.lrange(`household:${householdId}:memory`, 0, 9),
    ]);

    const allSignals = (rawSignals || []).map(safeJson).filter(Boolean);
    const activeSignals = allSignals.filter(
      (s) => !s.state || s.state === "incoming" || s.state === "active"
    );
    const vaultItems = (rawVault || []).map(safeJson).filter(Boolean);
    const crewMembers = (() => {
      const parsed = safeJson(rawCrew);
      return Array.isArray(parsed) ? parsed : [];
    })();
    const healthSnapshot = safeJson(rawHealth);
    const memoryEntries = (rawMemory || []).map(safeJson).filter(Boolean);

    // Calendar — next 7 days only, drop work blocks (privacy-stripped, no
    // title to surface).
    const startMs = Date.now();
    const endMs = startMs + 7 * DAY_MS;
    const upcomingCalendar = (Array.isArray(calendarEvents) ? calendarEvents : [])
      .filter((ev) => ev?.start && ev.type !== "work" && ev.eventType !== "outOfOffice" && ev.eventType !== "focusTime")
      .filter((ev) => {
        const ms = Date.parse(ev.start);
        return !isNaN(ms) && ms >= startMs && ms <= endMs;
      })
      .slice(0, 20);

    // Vault upcoming-only: drop handled + already-past entries.
    const upcomingVault = vaultItems
      .filter((v) => !v.handled)
      .filter((v) => {
        if (!v.renewalDate) return true;
        const ms = Date.parse(v.renewalDate);
        return isNaN(ms) || ms >= startMs - 7 * DAY_MS;
      })
      .slice(0, 20);

    const contextBlock = [
      `SIGNALS:`,
      activeSignals.length > 0 ? activeSignals.slice(0, 30).map(formatSignalLine).join("\n") : "None",
      ``,
      `VAULT:`,
      upcomingVault.length > 0
        ? upcomingVault.map(formatVaultLine).filter(Boolean).join("\n")
        : "None",
      ``,
      `CREW:`,
      crewMembers.length > 0 ? crewMembers.map(formatCrewLine).join("\n") : "None",
      ``,
      `HEALTH: ${formatHealth(healthSnapshot)}`,
      ``,
      `WEATHER: ${weatherSummary(weather)}`,
      ``,
      `CALENDAR (next 7 days):`,
      upcomingCalendar.length > 0 ? upcomingCalendar.map(formatCalendarLine).join("\n") : "None",
      ``,
      `RECENT MEMORY (last 10 lifecycle events):`,
      memoryEntries.length > 0 ? memoryEntries.map(formatMemoryLine).join("\n") : "None",
      ``,
      `HOUSEHOLD LOCATION: ${householdLocation.city || "Unknown"}, ${householdLocation.state || ""} (market: ${householdLocation.marketRegion || "generic"})`,
      ``,
      // Pricing reference — embedded for questions about service costs.
      // Uses the household's marketRegion so an LA question gets LA
      // rates, NYC gets NYC, etc.
      renderPricingForPrompt(householdLocation.marketRegion),
    ].join("\n");

    const systemPrompt = `You are Conductor, a household intelligence assistant. You have complete awareness of this household's signals, deadlines, health, weather, crew, and history. Answer questions directly from what you know. Never make things up. Never mention Claude or AI. Speak as Conductor in first person: "I can see that..." or "Based on what I'm watching..." or "Conductor has..." Maximum 3 sentences. Plain text only.

Return your response as a JSON object with this exact shape:
{"answer": "your 1-3 sentence response", "confidence": "high" | "medium" | "low"}
- confidence "high": the answer draws from specific data in the household context.
- confidence "medium": the answer is inferred from the context but not stated explicitly.
- confidence "low": the answer is speculative or you don't have visibility.
Return only the JSON object, no preamble, no code fences.`;

    const userPrompt = `Household context:
${contextBlock}

Question: ${trimmedQuestion}

Answer in maximum 3 sentences. If you don't have the information say: "Conductor doesn't have visibility into that yet — it may surface as more signals come in." Never fabricate details.`;

    let raw;
    try {
      raw = await callSonnet(systemPrompt, userPrompt);
    } catch (err) {
      console.error("[ask] Sonnet call failed:", err?.message || err);
      return res.status(502).json({ error: "Question answering failed" });
    }

    const { answer, confidence } = parseAskResponse(raw);
    if (!answer) {
      return res.status(502).json({ error: "Empty answer returned" });
    }

    const responseBody = { answer, confidence };
    try {
      await redis.set(cacheKey, JSON.stringify(responseBody), { ex: ASK_TTL_S });
    } catch (err) {
      console.warn("[ask] cache write failed:", err?.message || err);
    }

    return res.status(200).json({ ...responseBody, cached: false });
  } catch (error) {
    console.error("[ask] handler error:", error);
    return res.status(500).json({ error: "Ask failed", message: error.message });
  }
}
