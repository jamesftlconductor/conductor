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
  return `- ${title} | ${start}`;
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

const PRODUCT_KNOWLEDGE = {
  vault: "The Vault is your household's permanent record — insurance policies, subscriptions, warranties, registrations, and deadlines. Conductor populates it from Gmail automatically. You can also scan documents or add items manually.",
  brief: "The brief is a 3-5 sentence morning summary of what matters most in your household today. It arrives at 7am and gets smarter as Conductor learns your patterns.",
  hover: "Hover is your household radar — three rings showing signal urgency. Inner ring needs attention today. Middle ring is approaching. Outer ring is on the horizon. Tap any dot to see details.",
  radar: "Hover is your household radar — three rings showing signal urgency. Inner ring needs attention today. Middle ring is approaching. Outer ring is on the horizon.",
  pulse: "The Pulse synthesizes your health, weather, and signal load into one sentence about today. Tap it on the Ground screen to expand and see what's feeding into it.",
  crew: "Crew is everyone in your household — partners, children, pets. Each crew member has a bio with schedule, health details, and attributed signals.",
  horizon: "The Horizon shows everything beyond the next two weeks — Coming Up, Further Out, and On the Edge. Tap Noted to acknowledge without resolving.",
  programme: "The Programme is a 14-day timeline showing signals, crew events, vault deadlines, and calendar events on one view.",
  inventory: "Home Inventory is where you tell Conductor about your home's systems — roof, HVAC, water heater, vehicles. The more you fill in, the smarter the maintenance plan.",
  network: "The Network connects your household to family households you trust. You choose what to share — from emergency-only to full signal visibility.",
  maintenance: "The maintenance plan is an annual schedule generated from your home inventory with seasonal timing and real cost ranges. Each item can be added to your signal radar with one tap.",
  signal: "A signal is anything in your household that needs awareness or action — a delivery, a deadline, a service appointment, a renewal. Conductor finds signals in your Gmail automatically.",
  signals: "Signals are anything in your household that need awareness or action. Conductor finds them in your Gmail automatically and you can add manual ones.",
  rest: "Rest resolves a signal — it moves to the resolved state and contributes to your household streak.",
  streak: "The streak counts consecutive days where at least one signal was handled. It rewards keeping things in motion.",
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
                enum: ["NAVIGATE", "SETTINGS_CHANGE", "CREATE", "EXPLAIN", "QUERY"],
              },
              destination: { type: ["string", "null"] },
              settingKey: { type: ["string", "null"] },
              entity: { type: ["string", "null"] },
              explainTopic: { type: ["string", "null"] },
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
- SETTINGS_CHANGE: wants to change a setting ("turn on face id", "enable midday")
- CREATE: wants to create something ("add a reminder", "create a signal")
- EXPLAIN: wants to understand the product ("what is the vault", "how do I add crew", "what does rest mean")
- QUERY: wants household-specific info (everything else, including "what's coming up" / "what should this cost" / "how am I doing")

For NAVIGATE, set destination to the short label (e.g. "vault", "crew", "horizon").
For EXPLAIN, set explainTopic to the concept being asked about (e.g. "vault", "pulse").
For SETTINGS_CHANGE, set settingKey to a phrase like "face id" or "midday brief".
For CREATE, set entity to "signal" or "crew_member".

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
      answer: `That setting lives in Settings — opening it now.`,
      confidence: "medium",
      action: { type: "navigate", destination: "/settings" },
    };
  }
  if (intent.intent === "CREATE") {
    if ((intent.entity || "").toLowerCase().includes("crew")) {
      return {
        answer: `Opening the Crew screen — tap + to add a new member.`,
        confidence: "high",
        action: { type: "navigate", destination: "/crew" },
      };
    }
    // Default: route to add-signal sheet via Hover. The mobile side
    // can show the AddSignalSheet on focus.
    return {
      answer: `Opening Hover so you can add a signal.`,
      confidence: "high",
      action: { type: "navigate", destination: "/hover" },
    };
  }
  if (intent.intent === "EXPLAIN") {
    const topic = (intent.explainTopic || question).toLowerCase();
    const found = PRODUCT_KNOWLEDGE[topic] ||
      Object.entries(PRODUCT_KNOWLEDGE).find(([k]) => topic.includes(k))?.[1];
    if (!found) return null;
    return {
      answer: `${found} Want me to take you there?`,
      confidence: "high",
      action: { type: "navigate", destination: routeForTopic(topic) },
    };
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

  // Intent classification — fast Haiku call before the heavyweight
  // Sonnet path. NAVIGATE / SETTINGS_CHANGE / CREATE / EXPLAIN
  // intents short-circuit with a structured action; QUERY falls
  // through to the existing knowledge-base answer.
  try {
    const intent = await classifyIntent(trimmedQuestion);
    if (intent && intent.intent !== "QUERY") {
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

    const systemPrompt = `You are Conductor, a household intelligence assistant. You have complete awareness of this household's signals, deadlines, health, weather, crew, and history. Answer questions directly from what you know. Never make things up. Never mention Claude or AI. Speak as Conductor in first person: "I can see that..." or "Based on what I'm watching..." or "Conductor has..." Maximum 3 sentences. Plain text only.

${ratesBlock}

HOME SERVICES GUIDANCE:
- When the user asks about costs: give the market-specific range from the HOME SERVICES block above. If they share a quote, assess it as "within range" / "slightly high" / "above market — worth getting another quote." Note seasonal factors when relevant (e.g. summer HVAC premium, winter heating emergency rates).
- When the user asks for providers: check the PROVIDERS YOUR HOUSEHOLD HAS USED list first. If a relevant provider is on file, recommend them by name. If not, say so honestly and offer to find rated local options once that surface ships.
- Never invent provider names or phone numbers. Only use what's in the household provider history.
- When inventory data is relevant (age of HVAC, roof material, etc.), use it. If it's not provided, say "Conductor doesn't have that on file yet — adding it under Home Inventory would help" rather than guessing.

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
