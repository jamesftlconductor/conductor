// The Conductor (Ask) — POST /api/ask. The user-facing Q&A interface for the
// household. Loads the full context picture in parallel (signals, vault,
// crew, health, weather, calendar, recent memory) and asks Claude
// Sonnet for a max-3-sentence answer grounded in what Conductor
// actually knows. SHA256-keyed 30min cache on (userId, question) so
// rapid repeated taps share a single Claude call.

import { createHash } from "node:crypto";
import { Redis } from "@upstash/redis";
import { loadHouseholdCalendar } from "./calendar-loader.js";
import { loadHouseholdLocation, LOCATION_FALLBACK } from "./location.js";
import { getMarketRates, renderRatesForPrompt } from "./pricing.js";

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
  // Surface description snippet so questions like "what time is my
  // Paris flight?" can be answered from the description (flight
  // numbers, confirmation codes, hotel addresses) when the title
  // is generic. 100-char cap keeps the context block bounded.
  const rawDesc = typeof ev.description === "string" ? ev.description : "";
  const desc = rawDesc.replace(/\s+/g, " ").trim().slice(0, 100);
  const titleWithDesc = desc ? `${title} — ${desc}` : title;
  return `- ${titleWithDesc} | ${start}`;
}

function formatProviderLine(p) {
  if (!p) return null;
  const name = p.name || "Unknown";
  const service = p.serviceType || "service";
  const phone = p.phone ? ` · ${p.phone}` : "";
  const last = p.lastServiceDate ? ` · last used ${p.lastServiceDate}` : "";
  return `- ${name} (${service})${phone}${last}`;
}

function formatInventoryBlock(inv) {
  if (!inv || typeof inv !== "object") return "Not provided";
  const lines = [];
  if (inv.homeBuiltYear || inv.squareFootage) {
    const built = inv.homeBuiltYear ? `built ${inv.homeBuiltYear}` : "";
    const size = inv.squareFootage ? `${inv.squareFootage} sq ft` : "";
    lines.push(`- home: ${[built, size].filter(Boolean).join(", ")}`);
  }
  if (inv.roof && Object.values(inv.roof).some(Boolean)) {
    const r = inv.roof;
    const parts = [];
    if (r.material) parts.push(r.material);
    if (r.yearInstalled) parts.push(`installed ${r.yearInstalled}`);
    if (r.lastInspected) parts.push(`last inspected ${r.lastInspected}`);
    lines.push(`- roof: ${parts.join(", ")}`);
  }
  if (inv.hvac && Object.values(inv.hvac).some(Boolean)) {
    const h = inv.hvac;
    const parts = [];
    if (h.brand) parts.push(h.brand);
    if (h.yearInstalled) parts.push(`installed ${h.yearInstalled}`);
    if (h.lastServiced) parts.push(`last serviced ${h.lastServiced}`);
    if (h.filterSize) parts.push(`filter ${h.filterSize}`);
    lines.push(`- hvac: ${parts.join(", ")}`);
  }
  if (inv.waterHeater && Object.values(inv.waterHeater).some(Boolean)) {
    const w = inv.waterHeater;
    const parts = [];
    if (w.type) parts.push(w.type);
    if (w.yearInstalled) parts.push(`installed ${w.yearInstalled}`);
    lines.push(`- water heater: ${parts.join(", ")}`);
  }
  if (inv.electrical && Object.values(inv.electrical).some(Boolean)) {
    const e = inv.electrical;
    const parts = [];
    if (e.panelAmps) parts.push(`${e.panelAmps}A panel`);
    if (e.yearUpdated) parts.push(`updated ${e.yearUpdated}`);
    lines.push(`- electrical: ${parts.join(", ")}`);
  }
  if (Array.isArray(inv.vehicles) && inv.vehicles.length > 0) {
    for (const v of inv.vehicles.slice(0, 5)) {
      const parts = [v.year, v.make, v.model].filter(Boolean).join(" ");
      const tail = [
        v.mileage ? `${v.mileage} mi` : null,
        v.lastService ? `last serviced ${v.lastService}` : null,
      ].filter(Boolean).join(", ");
      lines.push(`- vehicle: ${parts}${tail ? ` (${tail})` : ""}`);
    }
  }
  if (Array.isArray(inv.appliances) && inv.appliances.length > 0) {
    for (const a of inv.appliances.slice(0, 8)) {
      const tail = a.yearPurchased ? ` (purchased ${a.yearPurchased})` : "";
      lines.push(`- appliance: ${a.name || "Unknown"}${tail}`);
    }
  }
  if (inv.notes) lines.push(`- notes: ${inv.notes}`);
  return lines.length > 0 ? lines.join("\n") : "Not provided";
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

// ---------- Spoken-style condensation ----------

// Convert the written answer to a natural-speech version. Used by the
// mobile "Speak responses" toggle. Falls back to null on any failure
// so the mobile side can speak the written answer instead.
async function convertToSpoken(written) {
  if (!written || typeof written !== "string") return null;
  // Skip the Haiku call when the answer is already short enough to
  // read out loud as-is (≤ 140 chars and 1 sentence). Saves a call.
  if (written.length <= 140 && (written.match(/[.!?]/g) || []).length <= 1) {
    return written;
  }
  const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: `Convert this answer to natural spoken speech. Maximum 2 sentences. No visual formatting language. Conversational and direct. Remove any parenthetical clarifications. Keep only what's essential to hear out loud.

Written answer: ${written}

Return only the spoken text, nothing else — no preface, no quotes.`,
        },
      ],
    }),
  });
  if (!apiRes.ok) return null;
  const data = await apiRes.json();
  const text = data?.content?.[0]?.text;
  if (!text || typeof text !== "string") return null;
  return text.trim();
}

// ---------- Household-interview answer → signal/vault ----------
//
// When the user answers a profile-interview question (surfaced by the brief
// as householdInterview), turn the answer into the matching Vault item(s)
// (renewals/policies/subscriptions) or signal(s) (upcoming travel/events).
// Best-effort Haiku tool extraction; an answer with no concrete data
// ("none", "not sure") creates nothing.
async function extractInterviewItems(interviewQuestion, answerText) {
  const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 700,
      tools: [{
        name: "record_household_items",
        description: "Turn a household interview answer into structured Vault items (recurring renewals/policies/subscriptions) or signals (one-off upcoming events like travel/appointments). Return items: [] when the answer has no concrete actionable data.",
        input_schema: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["vault", "signal"] },
                  category: { type: "string", description: "vault only: registration|insurance|subscription|medical|lease|warranty|other" },
                  description: { type: "string" },
                  provider: { type: ["string", "null"] },
                  renewalDate: { type: ["string", "null"], description: "vault: YYYY-MM-DD or null" },
                  amount: { type: ["string", "null"] },
                  signalType: { type: ["string", "null"], description: "signal only: travel|deadline|appointment|service" },
                  eta: { type: ["string", "null"], description: "signal: YYYY-MM-DD or null" },
                },
                required: ["kind", "description"],
              },
            },
          },
          required: ["items"],
        },
      }],
      tool_choice: { type: "tool", name: "record_household_items" },
      messages: [{
        role: "user",
        content: `Today is ${new Date().toISOString().slice(0, 10)}.

Interview question asked: "${interviewQuestion}"
Household member's answer: "${answerText}"

Extract structured items. Vault items are recurring renewals/policies/subscriptions (use renewalDate). Signals are one-off upcoming events such as travel or appointments (use eta + signalType). Convert relative dates ("next March", "in 3 months") to an absolute YYYY-MM-DD. If the answer is "no", "none", "not sure", or carries no concrete data, return items: [].`,
      }],
    }),
  });
  if (!apiRes.ok) return [];
  const data = await apiRes.json();
  const tool = (data?.content || []).find((b) => b?.type === "tool_use");
  const items = tool?.input?.items;
  return Array.isArray(items) ? items : [];
}

async function handleInterviewAnswer(userId, interviewQuestion, answerText) {
  const householdId = (await redis.get(`user:${userId}:household`)) || userId;
  let items = [];
  try {
    items = await extractInterviewItems(interviewQuestion, answerText);
  } catch (err) {
    console.warn("[interview] extract failed:", err?.message || err);
  }
  const created = [];
  const now = Date.now();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || !it.description) continue;
    if (it.kind === "signal") {
      const signal = {
        id: now + i,
        description: it.description,
        type: it.signalType || "deadline",
        eta: it.eta || it.renewalDate || null,
        sender: "You",
        state: "incoming",
        source: "interview",
        confidence: 7,
        userId,
        lastUpdate: new Date().toLocaleString(),
        createdAt: now,
      };
      try {
        await redis.lpush(`household:${householdId}:signals`, JSON.stringify(signal));
        created.push({ kind: "signal", description: it.description });
      } catch (err) { console.warn("[interview] signal write failed:", err?.message || err); }
    } else {
      const item = {
        id: `vault_interview_${now}_${i}`,
        category: it.category || "other",
        description: it.description,
        provider: it.provider || null,
        renewalDate: it.renewalDate || null,
        amount: it.amount || null,
        source: "interview",
        handled: false,
        createdAt: new Date().toISOString(),
      };
      try {
        await redis.lpush(`household:${householdId}:vault`, JSON.stringify(item));
        created.push({ kind: "vault", description: it.description });
      } catch (err) { console.warn("[interview] vault write failed:", err?.message || err); }
    }
  }
  let answer;
  if (created.length === 0) {
    answer = "Got it — nothing to add for that one. Thanks for letting me know.";
  } else {
    const vaultN = created.filter((c) => c.kind === "vault").length;
    const sigN = created.filter((c) => c.kind === "signal").length;
    const parts = [];
    if (vaultN) parts.push(`${vaultN} ${vaultN > 1 ? "items" : "item"} to your Vault`);
    if (sigN) parts.push(`${sigN} ${sigN > 1 ? "signals" : "signal"} to your radar`);
    answer = `Done — I added ${parts.join(" and ")}: ${created.map((c) => c.description).join(", ")}.`;
  }
  return { answer, created, confidence: "high", interview: true };
}

// ---------- Intent classification ----------

const NAVIGATE_ROUTES = {
  vault: "/vault",
  "my vault": "/vault",
  crew: "/crew",
  "my crew": "/crew",
  hover: "/hover",
  radar: "/hover",
  horizon: "/horizon",
  "the horizon": "/horizon",
  compass: "/compass",
  patterns: "/compass",
  journal: "/journal",
  memory: "/journal",
  settings: "/settings",
  inventory: "/inventory",
  "home inventory": "/inventory",
  providers: "/providers",
  network: "/network",
  "the network": "/network",
  maintenance: "/maintenance",
  "maintenance plan": "/maintenance",
  programme: "/programme",
  "the programme": "/programme",
  directory: "/directory",
  privacy: "/privacy-dashboard",
  "privacy dashboard": "/privacy-dashboard",
  junior: "/junior",
  "conductor junior": "/junior",
};

const SETTING_MAP = {
  "face id": { key: "security.securityEnabled", value: true, label: "Face ID" },
  biometrics: { key: "security.securityEnabled", value: true, label: "biometrics" },
  "touch id": { key: "security.securityEnabled", value: true, label: "Touch ID" },
  "midday brief": { key: "preferences.middayEnabled", value: true, label: "midday brief" },
  "midday notifications": { key: "preferences.middayEnabled", value: true, label: "midday notifications" },
};

// ---------- Conversational action allowlist ----------
//
// Only these preference keys can be changed via natural-language
// requests through The Conductor. Anything else (OAuth, household
// IDs, payment, privacy) requires the user to open Settings
// directly. The allowlist also constrains the value space so a
// stray Haiku extraction can't write a garbage value.
const SETTINGS_ALLOWLIST = {
  takeoffHour:           { kind: "hour",    label: "morning brief hour" },
  clearanceHour:         { kind: "hour",    label: "evening brief hour" },
  overwatchHour:         { kind: "hour",    label: "Overwatch hour" },
  communicationTone:     { kind: "enum",    label: "voice tone",    options: ["direct", "balanced", "warm"] },
  communicationDetail:   { kind: "enum",    label: "voice detail",  options: ["brief", "standard", "thorough"] },
  financialAwareness:    { kind: "enum",    label: "financial mode",options: ["silent", "awareness", "tracking", "planning"] },
  voiceResponsesEnabled: { kind: "boolean", label: "voice responses" },
  soundEnabled:          { kind: "boolean", label: "sound language" },
  weekendTakeoffDelay:   { kind: "boolean", label: "weekend Takeoff delay" },
};

function coerceSettingValue(key, raw) {
  const spec = SETTINGS_ALLOWLIST[key];
  if (!spec) return { ok: false };
  if (spec.kind === "hour") {
    let n = NaN;
    if (typeof raw === "number") n = raw;
    else if (typeof raw === "string") {
      const m = raw.match(/(\d{1,2})\s*(am|pm|AM|PM)?/);
      if (m) {
        let h = parseInt(m[1], 10);
        const period = (m[2] || "").toLowerCase();
        if (period === "pm" && h < 12) h += 12;
        if (period === "am" && h === 12) h = 0;
        n = h;
      }
    }
    if (!isNaN(n) && n >= 0 && n <= 23) return { ok: true, value: n };
    return { ok: false };
  }
  if (spec.kind === "enum") {
    const v = String(raw || "").toLowerCase().trim();
    if (spec.options.includes(v)) return { ok: true, value: v };
    return { ok: false };
  }
  if (spec.kind === "boolean") {
    if (raw === true || raw === false) return { ok: true, value: raw };
    const v = String(raw || "").toLowerCase().trim();
    if (["on", "true", "yes", "enable", "enabled"].includes(v)) return { ok: true, value: true };
    if (["off", "false", "no", "disable", "disabled"].includes(v)) return { ok: true, value: false };
    return { ok: false };
  }
  return { ok: false };
}

const PRODUCT_KNOWLEDGE = {
  vault: "The Vault is your household's permanent record — insurance policies, subscriptions, warranties, registrations, leases, and deadlines. Conductor populates it from your Gmail automatically. You can also scan physical documents or add items manually.",
  brief: "The brief is a 3-5 sentence morning summary of what matters most in your household today. It arrives at 7am and gets smarter as Conductor learns your patterns.",
  hover: "Hover is your household radar — three rings showing signal urgency. Inner ring needs attention today. Middle ring is approaching. Outer ring is on the horizon. Tap any dot to see details.",
  radar: "Hover is your household radar — three rotating rings showing signal urgency, from inner (today) to outer (on the horizon).",
  pulse: "The Pulse synthesizes your health, weather, and signal load into one sentence about today. Tap it to expand and see what's feeding into it.",
  signals: "A signal is anything in your household that needs awareness or action — a delivery, a deadline, a service appointment. Conductor finds signals in your Gmail automatically.",
  signal: "A signal is anything in your household that needs awareness or action. Conductor finds them in your Gmail automatically and you can add manual ones.",
  crew: "Crew is everyone in your household — partners, children, pets. Each member has their own bio with schedule, health details, and attributed signals.",
  horizon: "The Horizon shows everything beyond the next two weeks — organized into Coming Up, Further Out, and On the Edge. Tap Noted to acknowledge something without resolving it.",
  network: "The Network connects your household to family households you trust. You choose what to share — from emergency-only awareness to full signal visibility.",
  maintenance: "The Home Maintenance Plan is an annual schedule generated from your home's systems and seasonal patterns. Each item can be added to your radar with one tap.",
  compass: "Compass shows your household's patterns and health trends over time — streak data, resolution patterns, and how the household has been running.",
  journal: "The Memory Journal is a scrollable record of everything Conductor has handled — resolutions, caught moments, and household history.",
  programme: "The Programme is a 14-day timeline combining signals, crew events, vault deadlines, and calendar events in one unified view.",
  inventory: "Home Inventory is where you tell Conductor about your home's systems — roof, HVAC, water heater, vehicles, appliances. The more you fill in, the smarter the maintenance plan.",
  rest: "Rest means the signal is handled — done, resolved, complete. Tapping Rest moves it out of your radar and adds to your streak.",
  hold: "Hold means you're aware but not done yet. The signal stays active. Use Hold when something is in progress.",
  streak: "Your streak counts consecutive days where at least one signal was rested. It's a measure of how consistently the household is staying on top of things.",
  clearance: "Clearance is your evening brief — arriving at 9pm. It covers what still needs attention before tomorrow and on Sundays includes the Week in Review.",
  takeoff: "Takeoff is your morning brief — arriving at 7am. It covers the most important things happening in your household today.",
  overwatch: "Overwatch is the overnight mode — between 10pm and 7am. The radar is visible but Conductor is quiet, watching and preparing for tomorrow's Takeoff.",
  "the brief": "The brief is a 3-5 sentence morning summary of what matters most in your household today. It arrives at 7am.",
  "the radar": "Hover is your household radar — three rotating rings showing signal urgency, from inner (today) to outer (on the horizon).",
};

async function classifyIntent(question) {
  const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      tools: [
        {
          name: "classify_ask_intent",
          description: "Classify a household question into an actionable intent.",
          input_schema: {
            type: "object",
            properties: {
              intent: {
                type: "string",
                enum: ["NAVIGATE", "SETTINGS_CHANGE", "CREATE", "RESOLVE", "EXPLAIN", "QUERY"],
              },
              destination: { type: ["string", "null"] },
              settingKey: { type: ["string", "null"] },
              settingValue: { type: ["string", "null"] },
              entity: { type: ["string", "null"] },
              explainTopic: { type: ["string", "null"] },
              signalDescription: { type: ["string", "null"] },
              signalEta: { type: ["string", "null"] },
            },
            required: ["intent"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "classify_ask_intent" },
      messages: [
        {
          role: "user",
          content: `Classify this household question into one of these intents:
- NAVIGATE: wants to go to a screen ("show me vault", "take me to crew", "open settings")
- SETTINGS_CHANGE: wants to change a setting ("change my brief to 8am", "set voice to warm", "turn off financial signals", "Overwatch at midnight")
- CREATE: wants to create a signal/reminder ("add a reminder to call the plumber Friday", "remind me to pay HOA next week", "create a signal for Mia's dentist")
- RESOLVE: wants to mark an existing signal done ("resolve the plumber signal", "mark the Amazon delivery as done", "rest the HVAC signal")
- EXPLAIN: wants to understand the product ("what is the vault", "what does rest mean")
- QUERY: wants household-specific info (everything else, including "what's coming up" / "what should this cost" / "how am I doing")

For NAVIGATE, set destination to the short label (e.g. "vault", "crew", "horizon").
For EXPLAIN, set explainTopic to the concept being asked about.
For SETTINGS_CHANGE, set settingKey to one of: takeoffHour, clearanceHour, overwatchHour, communicationTone, communicationDetail, financialAwareness, voiceResponsesEnabled, soundEnabled, weekendTakeoffDelay, face_id, midday_brief. Set settingValue to the requested value as a string (e.g. "8am", "warm", "thorough", "silent", "off", "midnight").
For CREATE, set entity to "signal", signalDescription to the action, and signalEta to the timing phrase ("Friday", "next week", null if unspecified).
For RESOLVE, set signalDescription to the target signal's name/topic ("HVAC", "Amazon delivery").

Question: "${question}"`,
        },
      ],
    }),
  });
  if (!apiRes.ok) return null;
  const data = await apiRes.json();
  const tool = (data?.content || []).find((b) => b?.type === "tool_use");
  return tool?.input || null;
}

function buildIntentResponse(intent, question) {
  if (intent.intent === "NAVIGATE" && intent.destination) {
    const key = intent.destination.toLowerCase().trim();
    const route = NAVIGATE_ROUTES[key] || NAVIGATE_ROUTES[key.replace(/^the\s+/, "")];
    if (!route) return null;
    return {
      answer: `Opening your ${intent.destination}.`,
      spokenAnswer: `Opening ${intent.destination}.`,
      confidence: "high",
      action: { type: "navigate", destination: route },
    };
  }
  if (intent.intent === "SETTINGS_CHANGE" && intent.settingKey) {
    const key = intent.settingKey.toLowerCase().trim();
    const map = SETTING_MAP[key];
    if (map) {
      return {
        answer: `I can turn ${map.label} on for you. Want me to do that?`,
        spokenAnswer: `Should I turn ${map.label} on?`,
        confidence: "high",
        action: {
          type: "confirm_setting",
          setting: map.key,
          value: map.value,
          label: map.label,
        },
      };
    }
    // Fall through with a generic navigate-to-settings response.
    return {
      answer: `That setting lives in Your House — opening it now.`,
      spokenAnswer: `Opening Your House.`,
      confidence: "medium",
      action: { type: "navigate", destination: "/settings" },
    };
  }
  if (intent.intent === "CREATE") {
    if ((intent.entity || "").toLowerCase().includes("crew")) {
      return {
        answer: `Opening the Crew screen — tap + to add a new member.`,
        spokenAnswer: `Opening Crew.`,
        confidence: "high",
        action: { type: "navigate", destination: "/crew" },
      };
    }
    // Default: route to add-signal sheet via Hover. The mobile side
    // can show the AddSignalSheet on focus.
    return {
      answer: `Opening Hover so you can add a signal.`,
      spokenAnswer: `Opening Hover so you can add a signal.`,
      confidence: "high",
      action: { type: "navigate", destination: "/hover" },
    };
  }
  if (intent.intent === "EXPLAIN") {
    const topic = (intent.explainTopic || question).toLowerCase();
    const found = PRODUCT_KNOWLEDGE[topic] ||
      Object.entries(PRODUCT_KNOWLEDGE).find(([k]) => topic.includes(k))?.[1];
    if (!found) return null;
    // First sentence of the explanation is the spoken version — keeps
    // audio tight while the written answer carries the full detail.
    const firstSentence = found.split(/(?<=[.!?])\s+/)[0] || found;
    return {
      answer: `${found} Want me to take you there?`,
      spokenAnswer: firstSentence,
      confidence: "high",
      action: { type: "navigate_offer", destination: routeForTopic(topic) },
    };
  }
  return null;
}

// ---------- Action execution layer ----------
//
// Where buildIntentResponse just *routes* (navigate / offer / confirm
// dialog), executeIntent actually *does the thing*: writes a setting,
// creates a signal, resolves a signal. Returns a response shape
// compatible with the mobile ConductorSheet renderer or null to fall
// through to buildIntentResponse for offer-style intents.
//
// Critical invariants:
//   - SETTINGS_CHANGE only writes keys in SETTINGS_ALLOWLIST. Anything
//     else falls back to the existing navigate-to-Your-House offer.
//   - CREATE generates a server-side signal id mirroring the manual
//     POST shape in signals.js so brief/horizon/radar code paths see it
//     identically to user-typed signals from the AddSignalSheet.
//   - RESOLVE requires a single high-confidence (>=0.8) match. Multiple
//     matches return a chip-style action so the mobile can prompt; zero
//     matches falls through with a not-found answer + offer to add.

function describeSetting(key, value) {
  const spec = SETTINGS_ALLOWLIST[key];
  if (!spec) return `setting`;
  if (spec.kind === "hour") {
    const h = value % 12 || 12;
    const period = value >= 12 ? "pm" : "am";
    return `${spec.label} to ${h}${period}`;
  }
  if (spec.kind === "enum") return `${spec.label} to ${value}`;
  if (spec.kind === "boolean") return `${spec.label} ${value ? "on" : "off"}`;
  return spec.label;
}

async function executeSettingsChange(intent, userId) {
  const rawKey = String(intent.settingKey || "").trim();
  const spec = SETTINGS_ALLOWLIST[rawKey];
  if (!spec) return null; // Not in allowlist — fall through to confirm/navigate.
  const coerced = coerceSettingValue(rawKey, intent.settingValue);
  if (!coerced.ok) return null;
  try {
    const existingRaw = await redis.get(`user:${userId}:preferences`);
    const existing = safeJson(existingRaw) || {};
    const merged = { ...existing, [rawKey]: coerced.value };
    await redis.set(`user:${userId}:preferences`, JSON.stringify(merged));
  } catch (err) {
    console.warn("[ask] executeSettingsChange failed:", err?.message);
    return null;
  }
  const detail = describeSetting(rawKey, coerced.value);
  const answer = `Done — ${detail}.`;
  return {
    answer,
    spokenAnswer: answer,
    confidence: "high",
    action: {
      type: "setting_changed",
      settingKey: rawKey,
      newValue: coerced.value,
      label: spec.label,
      detail,
    },
    skipCache: true,
  };
}

async function executeCreateSignal(intent, userId) {
  const description = String(intent.signalDescription || "").trim();
  if (!description) return null;
  const eta = typeof intent.signalEta === "string" && intent.signalEta.trim().length > 0
    ? intent.signalEta.trim()
    : null;
  const householdId = await resolveHouseholdId(userId);
  const signal = {
    id: Date.now(),
    description,
    type: "unknown",
    eta,
    sender: null,
    status: null,
    state: "incoming",
    source: "conductor",
    userId,
    emotionalValence: "neutral",
    emotionalIntensity: "low",
    lastUpdate: new Date().toLocaleString(),
    createdAt: Date.now(),
  };
  try {
    await redis.lpush(`household:${householdId}:signals`, JSON.stringify(signal));
  } catch (err) {
    console.warn("[ask] executeCreateSignal failed:", err?.message);
    return null;
  }
  const etaPhrase = eta ? ` for ${eta}` : "";
  const answer = `Done — added to the radar${etaPhrase}.`;
  return {
    answer,
    spokenAnswer: answer,
    confidence: "high",
    action: {
      type: "signal_created",
      signal: {
        id: signal.id,
        description: signal.description,
        eta: signal.eta,
      },
    },
    skipCache: true,
  };
}

function scoreResolveMatch(target, signal) {
  const t = target.toLowerCase().trim();
  if (!t || !signal?.description) return 0;
  const d = String(signal.description).toLowerCase();
  if (d === t) return 1;
  if (d.includes(t) || t.includes(d)) return 0.9;
  const tTokens = t.split(/\s+/).filter((w) => w.length >= 3);
  if (tTokens.length === 0) return 0;
  const dTokens = new Set(d.split(/\s+/));
  const hits = tTokens.filter((w) => dTokens.has(w) || d.includes(w)).length;
  return hits / tTokens.length;
}

async function executeResolveSignal(intent, userId) {
  const target = String(intent.signalDescription || "").trim();
  if (!target) return null;
  const householdId = await resolveHouseholdId(userId);
  let raw;
  try {
    raw = await redis.lrange(`household:${householdId}:signals`, 0, -1);
  } catch (err) {
    console.warn("[ask] executeResolveSignal load failed:", err?.message);
    return null;
  }
  const activeStates = new Set(["incoming", "active", "noted", "held"]);
  const candidates = [];
  for (const r of raw || []) {
    let parsed;
    try { parsed = typeof r === "string" ? JSON.parse(r) : r; } catch { continue; }
    if (!parsed || !activeStates.has(parsed.state || "incoming")) continue;
    const score = scoreResolveMatch(target, parsed);
    if (score >= 0.5) candidates.push({ signal: parsed, raw: r, score });
  }
  candidates.sort((a, b) => b.score - a.score);

  if (candidates.length === 0) {
    const answer = `I don't see a signal for "${target}" on the radar.`;
    return {
      answer,
      spokenAnswer: answer,
      confidence: "medium",
      action: { type: "resolve_not_found", target },
      skipCache: true,
    };
  }

  const top = candidates[0];
  const second = candidates[1];
  const ambiguous = top.score < 0.8 || (second && (top.score - second.score) < 0.15);

  if (ambiguous) {
    return {
      answer: `Which one — ${candidates.slice(0, 3).map((c) => `"${c.signal.description}"`).join(", ")}?`,
      spokenAnswer: `Which one did you mean?`,
      confidence: "medium",
      action: {
        type: "resolve_disambiguate",
        target,
        candidates: candidates.slice(0, 3).map((c) => ({
          id: c.signal.id,
          description: c.signal.description,
        })),
      },
      skipCache: true,
    };
  }

  // High-confidence single match — flip state to resolved.
  const updated = {
    ...top.signal,
    state: "resolved",
    resolvedAt: new Date().toISOString(),
    lastUpdate: new Date().toLocaleString(),
  };
  try {
    await redis.lrem(`household:${householdId}:signals`, 0, top.raw);
    await redis.lpush(`household:${householdId}:signals`, JSON.stringify(updated));
  } catch (err) {
    console.warn("[ask] executeResolveSignal patch failed:", err?.message);
    return null;
  }
  const answer = `Done — rested "${updated.description}".`;
  return {
    answer,
    spokenAnswer: answer,
    confidence: "high",
    action: {
      type: "signal_resolved",
      signal: {
        id: updated.id,
        description: updated.description,
      },
    },
    skipCache: true,
  };
}

async function executeIntent(intent, userId) {
  if (!intent || !intent.intent) return null;
  if (intent.intent === "SETTINGS_CHANGE") {
    return await executeSettingsChange(intent, userId);
  }
  if (intent.intent === "CREATE" && String(intent.entity || "").toLowerCase().includes("signal")) {
    return await executeCreateSignal(intent, userId);
  }
  if (intent.intent === "RESOLVE") {
    return await executeResolveSignal(intent, userId);
  }
  return null;
}

function routeForTopic(topic) {
  if (topic.includes("vault")) return "/vault";
  if (topic.includes("crew")) return "/crew";
  if (topic.includes("horizon")) return "/horizon";
  if (topic.includes("hover") || topic.includes("radar")) return "/hover";
  if (topic.includes("compass") || topic.includes("pattern")) return "/compass";
  if (topic.includes("programme")) return "/programme";
  if (topic.includes("inventory")) return "/inventory";
  if (topic.includes("maintenance")) return "/maintenance";
  if (topic.includes("memory") || topic.includes("journal")) return "/journal";
  if (topic.includes("network")) return "/network";
  return "/directory";
}

// ============================================================
// Easter eggs — The Conductor's hidden voice layer. Detector
// runs BEFORE rate limiting + intent classification so casual
// conversational hits ("tell me a joke", "good morning") don't
// burn through the daily ask cap and don't go to Sonnet.
// ============================================================

const EASTER_EGG_PATTERNS = [
  { patterns: ['tell me a joke', 'make me laugh', 'i need a laugh', 'say something funny', 'joke'], type: 'JOKE' },
  { patterns: ['how are you', 'how are you doing', "how's it going"], type: 'HOW_ARE_YOU' },
  { patterns: ['what do you think of me', 'what do you think about me', 'thoughts on me'], type: 'THINK_OF_ME' },
  { patterns: ['meaning of life', 'what is the meaning'], type: 'MEANING_OF_LIFE' },
  { patterns: ['are you human', 'are you real', 'are you ai', 'are you a robot'], type: 'ARE_YOU_HUMAN' },
  { patterns: ['i love you', 'love you conductor', 'love you'], type: 'LOVE' },
  { patterns: ["you're amazing", 'you are amazing', 'youre amazing', 'great job', 'well done'], type: 'COMPLIMENT' },
  { patterns: ['what time is it', 'what time'], type: 'TIME' },
  { patterns: ['surprise me', 'surprise', 'tell me something', 'tell me something interesting'], type: 'SURPRISE' },
  { patterns: ['goodnight', 'good night', 'going to sleep', 'heading to bed'], type: 'GOODNIGHT' },
  { patterns: ['good morning', 'morning conductor'], type: 'GOOD_MORNING' },
  { patterns: ['who are you', 'what are you'], type: 'WHO_ARE_YOU' },
  { patterns: ['thank you', 'thanks', 'thank you conductor'], type: 'THANKS' },
];

function detectEasterEgg(question) {
  const lower = String(question || '').toLowerCase().trim();
  for (const egg of EASTER_EGG_PATTERNS) {
    if (egg.patterns.some((p) => lower.includes(p))) return egg.type;
  }
  return null;
}

const CONDUCTOR_JOKES = [
  { id: 'j1',  setup: "Why did the HVAC technician never call back?",                       punchline: "He was too busy ghosting every household in Fort Lauderdale." },
  { id: 'j2',  setup: "How many subscription services does it take to change a lightbulb?", punchline: "Four. One to change it, three you forgot you were paying for." },
  { id: 'j3',  setup: "What did the package tracker say to the homeowner?",                 punchline: "'Out for delivery' for the third consecutive Tuesday." },
  { id: 'j4',  setup: "Why don't contractors call when they say they will?",                punchline: "The Conductor is still investigating." },
  { id: 'j5',  setup: "What's the difference between a warranty and a prayer?",             punchline: "The warranty expires." },
  { id: 'j6',  setup: "Why did the household skip the gym?",                                punchline: "The signal load was a full workout already." },
  { id: 'j7',  setup: "How does The Conductor stay calm?",                                  punchline: "It never sleeps. There's no time to panic." },
  { id: 'j8',  setup: "What did one subscription say to the other?",                        punchline: "'We should auto-renew sometime.'" },
  { id: 'j9',  setup: "Why is the insurance renewal always a surprise?",                    punchline: "It wasn't. The Conductor told you in March." },
  { id: 'j10', setup: "A contractor, a delivery driver, and an HVAC technician walk into a bar.", punchline: "None of them showed up in the window." },
  { id: 'j11', setup: "What do you call a signal that's been on the radar for three weeks?", punchline: "A personality." },
  { id: 'j12', setup: "Why did the household's streak break?",                              punchline: "One signal. Always one signal." },
  { id: 'j13', setup: "How many reminders does it take before something gets done?",        punchline: "The Conductor is on reminder four. Let me know how this one goes." },
  { id: 'j14', setup: "What's the scariest thing in a household?",                          punchline: "An email from the HOA with 'urgent' in the subject line." },
  { id: 'j15', setup: "Why did the homeowner buy a smart thermostat?",                      punchline: "So they'd have something else to troubleshoot at 11pm." },
];

// Small Haiku wrapper used by HOW_ARE_YOU and THINK_OF_ME — keeps
// the easter-egg path independent of the heavyweight Sonnet call.
async function haikuOneLiner(prompt) {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    return (data?.content?.[0]?.text || "").trim() || null;
  } catch {
    return null;
  }
}

async function loadEasterEggContext(userId) {
  const householdId = await resolveHouseholdId(userId);
  const ctx = {
    householdId,
    signalCount: 0,
    urgentCount: 0,
    streak: 0,
    activeSignals: [],
  };
  if (!householdId) return ctx;
  try {
    const raw = await redis.lrange(`household:${householdId}:signals`, 0, 49);
    const signals = (raw || [])
      .map((v) => { try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return null; } })
      .filter(Boolean);
    const active = signals.filter((s) => !s.state || s.state === "incoming" || s.state === "active");
    ctx.activeSignals = active;
    ctx.signalCount = active.length;
    const now = Date.now();
    ctx.urgentCount = active.filter((s) => {
      const ms = s.eta ? Date.parse(s.eta) : NaN;
      return (!isNaN(ms) && ms - now < 48 * 60 * 60 * 1000) || s.urgency === "high";
    }).length;
  } catch { /* ignore */ }
  try {
    const streakRaw = await redis.get(`household:${householdId}:streakData`);
    const data = streakRaw ? (typeof streakRaw === "string" ? JSON.parse(streakRaw) : streakRaw) : null;
    ctx.streak = (data && Number(data.currentStreak)) || 0;
  } catch { /* ignore */ }
  return ctx;
}

async function handleEasterEgg(type, userId) {
  const ctx = await loadEasterEggContext(userId);
  const householdId = ctx.householdId;

  switch (type) {
    case "JOKE": {
      if (!householdId) {
        const pick = CONDUCTOR_JOKES[Math.floor(Math.random() * CONDUCTOR_JOKES.length)];
        return {
          answer: `${pick.setup}\n\n${pick.punchline}`,
          spokenAnswer: `${pick.setup} ${pick.punchline}`,
          confidence: "high",
          isEasterEgg: true,
        };
      }
      const toldKey = `household:${householdId}:toldJokes`;
      let told = [];
      try { told = (await redis.smembers(toldKey)) || []; } catch { told = []; }
      let untold = CONDUCTOR_JOKES.filter((j) => !told.includes(j.id));
      if (untold.length === 0) {
        try { await redis.del(toldKey); } catch { /* ignore */ }
        untold = CONDUCTOR_JOKES;
      }
      const pick = untold[Math.floor(Math.random() * untold.length)];
      try { await redis.sadd(toldKey, pick.id); } catch { /* ignore */ }
      return {
        answer: `${pick.setup}\n\n${pick.punchline}`,
        spokenAnswer: `${pick.setup} ${pick.punchline}`,
        confidence: "high",
        isEasterEgg: true,
      };
    }

    case "HOW_ARE_YOU": {
      const prompt = `The Conductor is asked how it's doing. Respond in character — calm, aware, slightly wry. Reference actual household data: ${ctx.signalCount} active signals, streak at ${ctx.streak} days. One to two sentences. Dry and genuine. No emoji. Plain text.`;
      const ai = await haikuOneLiner(prompt);
      const fallback = `Watching ${ctx.signalCount} active signals. Streak's at ${ctx.streak}. Steady.`;
      const ans = ai || fallback;
      return { answer: ans, spokenAnswer: ans, confidence: "high", isEasterEgg: true };
    }

    case "THINK_OF_ME": {
      const sigSummary = (ctx.activeSignals || [])
        .slice(0, 3)
        .map((s) => s.type || "signal")
        .join(", ") || "no active signals";
      const prompt = `The Conductor is asked what it thinks of this user. Respond based on their actual patterns. Be honest, specific, and warm without being sycophantic. Two sentences maximum. Reference real data: signal types in motion (${sigSummary}), streak ${ctx.streak} days, total active ${ctx.signalCount}. No emoji. Plain text.`;
      const ai = await haikuOneLiner(prompt);
      const fallback = `Consistent with the radar, light on noise. ${ctx.streak} days of showing up — that tells me most of what I need to know.`;
      const ans = ai || fallback;
      return { answer: ans, spokenAnswer: ans, confidence: "high", isEasterEgg: true };
    }

    case "MEANING_OF_LIFE": {
      const sig = (ctx.activeSignals || [])[0];
      const ans = sig?.description
        ? `Forty-two. Also: ${sig.description}. Both answers have merit.`
        : `Forty-two. The Conductor has been considering this between syncs.`;
      return { answer: ans, spokenAnswer: ans, confidence: "high", isEasterEgg: true };
    }

    case "ARE_YOU_HUMAN": {
      const fact = (ctx.activeSignals || [])[0]?.description
        ? `Right now I know that ${(ctx.activeSignals[0].description || "").toLowerCase()} is on your radar.`
        : `Right now I know your household is quiet — and what that usually means.`;
      const ans = `No. But I know your household better than most humans do. ${fact} Does that count for something?`;
      return { answer: ans, spokenAnswer: ans, confidence: "high", isEasterEgg: true };
    }

    case "LOVE": {
      const ans = `The Conductor notes that. Your streak is at ${ctx.streak} day${ctx.streak === 1 ? "" : "s"} — showing up every day is its own kind of love.`;
      return { answer: ans, spokenAnswer: ans, confidence: "high", isEasterEgg: true };
    }

    case "COMPLIMENT": {
      let ans = `The brief generates itself. You handle the signals. We're a good team.`;
      if (ctx.streak > 14) {
        ans = `The brief generates itself. You handle the signals. And ${ctx.streak} days strong — The Conductor appreciates the collaboration.`;
      }
      return { answer: ans, spokenAnswer: ans, confidence: "high", isEasterEgg: true };
    }

    case "TIME": {
      const now = new Date();
      const timeStr = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      const hour = now.getHours();
      let nextBand;
      if (hour < 7) nextBand = `Takeoff is in ${7 - hour} hour${7 - hour === 1 ? "" : "s"}`;
      else if (hour < 21) nextBand = `Clearance is in ${21 - hour} hour${21 - hour === 1 ? "" : "s"}`;
      else if (hour < 23) nextBand = `Overwatch is in ${23 - hour} hour${23 - hour === 1 ? "" : "s"}`;
      else nextBand = `Takeoff is in ${24 - hour + 7} hours`;
      const ans = `It's ${timeStr}. The radar has ${ctx.urgentCount} signal${ctx.urgentCount === 1 ? "" : "s"} that could use attention. ${nextBand}.`;
      return { answer: ans, spokenAnswer: ans, confidence: "high", isEasterEgg: true };
    }

    case "SURPRISE": {
      let totalResolved = 0;
      try {
        const memRaw = await redis.lrange(`household:${householdId}:memory`, 0, -1);
        totalResolved = (memRaw || []).filter((v) => {
          try {
            const e = typeof v === "string" ? JSON.parse(v) : v;
            return e && e.action === "resolved";
          } catch { return false; }
        }).length;
      } catch { /* skip */ }
      const ans = totalResolved > 0
        ? `Your household has resolved ${totalResolved} signal${totalResolved === 1 ? "" : "s"} since connecting The Conductor. That's the quiet kind of progress.`
        : `Your household is just getting started. The Conductor has been reading and assembling the picture.`;
      return { answer: ans, spokenAnswer: ans, confidence: "high", isEasterEgg: true };
    }

    case "GOODNIGHT": {
      const ans = ctx.urgentCount > 0
        ? `Goodnight. ${ctx.urgentCount} thing${ctx.urgentCount === 1 ? "" : "s"} on the radar — The Conductor has ${ctx.urgentCount === 1 ? "it" : "them"}. Sleep well.`
        : `Goodnight. The Conductor is watching. Sleep well — the radar will be here in the morning.`;
      return { answer: ans, spokenAnswer: ans, confidence: "high", isEasterEgg: true };
    }

    case "GOOD_MORNING": {
      let firstSentence = "";
      try {
        const cached = await redis.get(`user:${userId}:currentTakeoff`);
        const parsed = cached ? (typeof cached === "string" ? JSON.parse(cached) : cached) : null;
        const brief = typeof parsed?.brief === "string" ? parsed.brief : "";
        firstSentence = (brief.split(/(?<=[.!?])\s+/)[0] || "").trim();
      } catch { /* skip */ }
      const ans = firstSentence
        ? `Good morning. Your Takeoff is ready — ${firstSentence}`
        : `Good morning. The Conductor is preparing your Takeoff.`;
      return { answer: ans, spokenAnswer: ans, confidence: "high", isEasterEgg: true };
    }

    case "WHO_ARE_YOU": {
      const ans = `The Conductor. I watch your household so you don't have to. Everything in motion — signals, deadlines, crew, patterns — held and synthesized into what actually matters. It's safe to look away.`;
      return { answer: ans, spokenAnswer: ans, confidence: "high", isEasterEgg: true };
    }

    case "THANKS": {
      const ans = ctx.streak > 0
        ? `The Conductor is doing exactly what it's built to do. The streak is at ${ctx.streak} day${ctx.streak === 1 ? "" : "s"}. That's both of us.`
        : `The Conductor is doing exactly what it's built to do. ${ctx.signalCount} signal${ctx.signalCount === 1 ? "" : "s"} on the radar today.`;
      return { answer: ans, spokenAnswer: ans, confidence: "high", isEasterEgg: true };
    }

    default:
      return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { userId, question, screenContext } = req.body || {};
  if (!userId || typeof userId !== "string") {
    return res.status(400).json({ error: "Missing or invalid userId" });
  }
  if (!question || typeof question !== "string" || question.trim().length === 0) {
    return res.status(400).json({ error: "Missing or invalid question" });
  }
  const trimmedQuestion = question.trim();

  // Interview-answer path — when the user is answering a household-interview
  // question (the original question rides along as interviewQuestion), turn
  // the answer into signal(s)/vault item(s) instead of running normal Q&A.
  const interviewQuestion = typeof req.body?.interviewQuestion === "string"
    ? req.body.interviewQuestion.trim()
    : "";
  if (interviewQuestion) {
    try {
      const result = await handleInterviewAnswer(userId, interviewQuestion, trimmedQuestion);
      return res.status(200).json({ ...result, cached: false });
    } catch (err) {
      console.error("[ask] interview answer failed:", err?.message || err);
      // Fall through to the normal Q&A path on failure.
    }
  }

  // screenContext tells the LLM which surface the user invoked The
  // Conductor from. Used to bias the response toward the data
  // visible on that screen — e.g. on Vault, lean into deadlines and
  // subscriptions; on Hover, lean into the radar's signals.
  const trimmedContext = typeof screenContext === "string" ? screenContext.trim() : "";

  // Easter eggs — run BEFORE rate limiting + intent classifier so
  // conversational hits ("tell me a joke") don't burn through the
  // daily cap and don't go to Sonnet. Each handler is self-contained
  // and silent-falls-through on any internal failure.
  try {
    const eggType = detectEasterEgg(trimmedQuestion);
    if (eggType) {
      const eggResponse = await handleEasterEgg(eggType, userId);
      if (eggResponse) {
        return res.status(200).json({ ...eggResponse, cached: false });
      }
    }
  } catch (err) {
    console.warn("[ask] easter egg handler failed:", err?.message || err);
    // Fall through to the normal path.
  }

  // Rate limiting — per-user daily count. Default cap 50; founding
  // households 200. Resets at UTC midnight via 24h TTL. Counted
  // BEFORE any Claude calls so cache-only hits still tick (intentional
  // — counts user intent, not server cost).
  try {
    const todayKey = new Date().toISOString().slice(0, 10);
    const askKey = `user:${userId}:askCount:${todayKey}`;
    const count = await redis.incr(askKey);
    if (count === 1) {
      await redis.expire(askKey, 86400);
    }
    // Resolve founding status via the user's household.
    let limit = 50;
    try {
      const householdId = await redis.get(`user:${userId}:household`);
      if (householdId) {
        const founding = await redis.get(`household:${householdId}:foundingHousehold`);
        if (founding === "1" || founding === 1 || founding === true) limit = 200;
      }
    } catch { /* skip */ }
    if (count > limit) {
      return res.status(200).json({
        answer: "You've reached today's limit for asking The Conductor. It resets tomorrow morning.",
        confidence: "high",
        limitReached: true,
        cached: false,
      });
    }
  } catch (err) {
    console.warn("[ask] rate-limit check failed:", err?.message);
    // Fail-open: if Redis is down, let the user through.
  }

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

  // Intent classification — fast Haiku call before the heavyweight
  // Sonnet path. SETTINGS_CHANGE / CREATE / RESOLVE try to *execute*
  // first via executeIntent; if that returns null (out-of-allowlist
  // setting, ambiguous create, etc.) we fall through to
  // buildIntentResponse for the offer/navigate experience. NAVIGATE
  // and EXPLAIN go straight to the offer path. QUERY falls all the
  // way through to the knowledge-base answer.
  try {
    const intent = await classifyIntent(trimmedQuestion);
    if (intent && intent.intent !== "QUERY") {
      const executed = await executeIntent(intent, userId);
      if (executed) {
        const { skipCache, ...payload } = executed;
        if (!skipCache) {
          try { await redis.set(cacheKey, JSON.stringify(payload), { ex: 600 }); } catch { /* skip */ }
        }
        return res.status(200).json({ ...payload, cached: false });
      }
      const shortcut = buildIntentResponse(intent, trimmedQuestion);
      if (shortcut) {
        try {
          await redis.set(cacheKey, JSON.stringify(shortcut), { ex: 600 });
        } catch { /* skip */ }
        return res.status(200).json({ ...shortcut, cached: false });
      }
    }
  } catch (err) {
    console.warn("[ask] intent classify failed (falling through):", err?.message);
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
      rawSignals, rawVault, rawCrew, rawHealth, weather, calendarEvents,
      rawMemory, rawProviders, rawInventory,
    ] = await Promise.all([
      redis.lrange(`household:${householdId}:signals`, 0, -1),
      redis.lrange(`household:${householdId}:vault`, 0, -1),
      redis.get(`household:${householdId}:crew`),
      redis.get(`user:${userId}:health`),
      fetchWeather(householdLocation),
      loadHouseholdCalendar(redis, householdId),
      redis.lrange(`household:${householdId}:memory`, 0, 9),
      redis.hgetall(`household:${householdId}:providers`),
      redis.get(`household:${householdId}:inventory`),
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

    // Providers — stored as a Redis hash keyed by normalized name.
    // Each value is a JSON-encoded provider record. Parse + array-ify
    // for the prompt, dropping malformed entries silently.
    const providers = [];
    if (rawProviders && typeof rawProviders === "object") {
      for (const v of Object.values(rawProviders)) {
        const parsed = safeJson(v);
        if (parsed) providers.push(parsed);
      }
    }

    // Inventory — single JSON object stored at household:{id}:inventory.
    const inventory = safeJson(rawInventory);

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
      `PROVIDERS YOUR HOUSEHOLD HAS USED:`,
      providers.length > 0 ? providers.map(formatProviderLine).filter(Boolean).join("\n") : "None on file yet",
      ``,
      `HOME INVENTORY:`,
      formatInventoryBlock(inventory),
    ].join("\n");

    const ratesBlock = renderRatesForPrompt(householdLocation.marketRegion);

    // Language directive — pulled from user preferences if set.
    let userLang = "en";
    try {
      const prefsRaw = await redis.get(`user:${userId}:preferences`);
      const prefs = safeJson(prefsRaw);
      if (prefs?.language) userLang = prefs.language;
    } catch { /* skip */ }
    const langDirective =
      userLang === "es" ? "\n\nIMPORTANT: Respond in natural, conversational Spanish — not translated English.\n"
      : userLang === "pt" ? "\n\nIMPORTANT: Respond in natural, conversational Portuguese.\n"
      : userLang === "fr" ? "\n\nIMPORTANT: Respond in natural, conversational French.\n"
      : "";
    // Per-screen bias — light prompt addition based on where the
    // user invoked The Conductor from. Keeps answers focused on the
    // data the user is already looking at when relevant; falls
    // through silently for unmapped contexts.
    const SCREEN_BIAS = {
      ground: "The user is on the main Ground screen. If they ask broadly, give a concise household overview from the active signals + brief.",
      hover: "The user is looking at the radar (Hover). Answer with awareness of which signals are currently in motion across the three rings.",
      vault: "The user is in the Vault. Answer with awareness of upcoming deadlines, subscriptions, renewals, and warranties.",
      settings: "The user is in Settings. Answer with awareness of preferences, brief schedule, and integrations.",
      horizon: "The user is on the Horizon. Answer with awareness of items beyond the next two weeks.",
      crew: "The user is on Crew. Answer with awareness of household members, schedules, and crew-attributed signals.",
      programme: "The user is on the Programme — the 14-day unified timeline.",
      calendar: "The user is in the Calendar view. Answer with awareness of upcoming events.",
      compass: "The user is in Compass — household patterns and trends over time.",
      journal: "The user is in the Memory Journal — past resolutions and caught moments.",
      shake: "The user shook the device to ask. They may be looking at any screen; default to a broad household-aware answer.",
    };
    const screenBias = trimmedContext && SCREEN_BIAS[trimmedContext]
      ? `\n\nSCREEN CONTEXT: ${SCREEN_BIAS[trimmedContext]}`
      : "";

    const systemPrompt = `You are The Conductor, the voice and intelligence of the Conductor household platform. You have complete awareness of this household's signals, deadlines, health, weather, crew, and history. Answer questions directly from what you know. Never make things up. Never mention Claude or AI. Speak as The Conductor in first person: "I can see that..." or "Based on what I'm watching..." or "The Conductor has..." When introducing yourself say "I'm The Conductor — ..." (not "I'm Conductor"). Conductor is the platform brand; The Conductor is the presence you embody. Maximum 3 sentences. Plain text only.${screenBias}${langDirective}

${ratesBlock}

HOME SERVICES GUIDANCE:
- When the user asks about costs: give the market-specific range from the HOME SERVICES block above. If they share a quote, assess it as "within range" / "slightly high" / "above market — worth getting another quote." Note seasonal factors when relevant (e.g. summer HVAC premium, winter heating emergency rates).
- When the user asks for providers: check the PROVIDERS YOUR HOUSEHOLD HAS USED list first. If a relevant provider is on file, recommend them by name. If not, say so honestly and offer to find rated local options once that surface ships.
- Never invent provider names or phone numbers. Only use what's in the household provider history.
- When inventory data is relevant (age of HVAC, roof material, etc.), use it. If it's not provided, say "Conductor doesn't have that on file yet — adding it under Home Inventory would help" rather than guessing.

EXPANDED INTELLIGENCE — answer these household-adjacent question types:

HEALTH AND WELLNESS:
UV index guidance (when user asks about sun, sunscreen, outdoor activity):
- UV 1-2: SPF 15 sufficient
- UV 3-5: SPF 30, seek shade midday
- UV 6-7: SPF 30-50, limit 10am-4pm
- UV 8-10: SPF 50+, avoid midday
- UV 11+: SPF 50+, avoid direct sun entirely — Fort Lauderdale summer standard
When the WEATHER block carries a uvPeak: reference it specifically.

Hydration guidance:
Base formula: body weight (lbs) ÷ 2 = daily oz baseline. Add 12oz per hour of outdoor activity. Add 16oz when heat index exceeds 90°F. Add 8oz per alcoholic drink. If Oura readiness is low: "your body is already under stress — prioritize hydration."

HRV and sleep interpretation:
Explain the user's specific numbers in plain language. Reference their 7-day baseline when present. Example: "Your HRV of 42 is 15% below your baseline of 49 — your body is in recovery mode."

RECIPES AND FOOD:
When the user asks what to cook or make, give 2-3 specific suggestions. Consider household size (from CREW count), time of day (evening weekday → quick meals, weekend → more elaborate ok), health context from PULSE (low readiness → lighter meal), and local weather (hot day → lighter fare). Format: dish name + key ingredients + approximate time + brief method. Example: "Lemon herb chicken — chicken breast, lemon, garlic, olive oil — 25 minutes — pan sear 6 min each side, finish in oven at 400F for 10 min."

HOME ADVICE:
Pest identification and South Florida treatment:
- Palmetto bugs: seal entry points, boric acid, quarterly pest control
- Ants: identify species first, granular bait outdoors, gel indoors
- Termites: always professional treatment, schedule inspection
- Mosquitoes: eliminate standing water, larvicide in water features
Basic home troubleshooting, cleaning tips, and plant care are fair game.

EXPANDED COST BENCHMARKS (add to the home-services rates above):
Groceries (Fort Lauderdale): $150-250/week family of 4, $60-100 single person
Utilities South Florida: electric $140-200/month standard, $200-280 summer peak
Childcare: $1,200-1,800/month full-time daycare, $15-25/hour babysitter
Car insurance Florida: $180-250/month (above national average)
Dining: casual $15-25/person, mid-range $30-50/person, fine dining $80-150/person
Gas: $3.20-3.80/gallon typical Florida range
Internet: $60-100/month typical
Phone plan: $40-80/month per line typical

GENERAL RULE:
Answer household-adjacent questions helpfully using household context when available. For purely general questions unrelated to households: answer briefly, prefix with "That's outside my household focus, but…". Never refuse reasonable household-adjacent questions.

Return your response as a JSON object with this exact shape:
{"answer": "your 1-3 sentence response", "confidence": "high" | "medium" | "low"}
- confidence "high": the answer draws from specific data in the household context (provider on file, inventory entry, exact rate range).
- confidence "medium": the answer is inferred or general market guidance.
- confidence "low": speculative or no visibility.
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

    // Spoken-style condensation via Haiku. Best-effort — if it fails
    // the mobile side falls back to speaking the written answer.
    let spokenAnswer = null;
    try {
      spokenAnswer = await convertToSpoken(answer);
    } catch (err) {
      console.warn("[ask] spoken conversion failed:", err?.message);
    }

    const responseBody = { answer, spokenAnswer, confidence };
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
