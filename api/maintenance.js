// Home maintenance plan generator + offer state.
//
// GET /api/maintenance?userId=...
//   Returns { plan, offerReady, offerDismissed }. plan may be null
//   when no plan has been generated yet.
//
// POST /api/maintenance with body.action ∈ {generate, dismiss,
//                                            addToRadar}
//
//   generate    Calls Claude Sonnet with full household context +
//               market rates to produce a 12-month plan. Stored at
//               household:{id}:maintenancePlan (365-day TTL) +
//               returned.
//   dismiss     Sets household:{id}:maintenanceOfferDismissed
//               permanently (no TTL).
//   addToRadar  Body { task, month, category, costLow, costHigh }
//               creates a "service" signal in :signals with a first-
//               of-month eta and source='maintenance_plan'.

import { Redis } from "@upstash/redis";
import { getMarketRates, renderRatesForPrompt } from "./pricing.js";
import { loadHouseholdLocation, LOCATION_FALLBACK } from "./location.js";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const ONE_YEAR_SEC = 365 * 24 * 60 * 60;

function safeJson(v) {
  if (v == null) return null;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return null; }
}

async function resolveHouseholdId(userId) {
  if (!userId) return null;
  const hid = await redis.get(`user:${userId}:household`);
  return hid || userId;
}

// Offer readiness gate. We surface the maintenance-plan offer in
// the brief only when the household actually has enough inventory
// data to make a plan worth generating, AND we haven't already
// generated one in the last year, AND the user hasn't dismissed.
async function evaluateOfferReady(householdId) {
  const [planRaw, dismissed, invRaw] = await Promise.all([
    redis.get(`household:${householdId}:maintenancePlan`),
    redis.get(`household:${householdId}:maintenanceOfferDismissed`),
    redis.get(`household:${householdId}:inventory`),
  ]);
  const plan = safeJson(planRaw);
  const offerDismissed = dismissed === true || dismissed === "true";

  // ANY inventory data is enough. A partial plan with only an HVAC
  // entry is more useful than no plan — the generator skips empty
  // sections and notes which data would round out coverage.
  //
  // Renter / living-with-family households use a narrower gate:
  // they only need *personal* inventory (vehicles or appliances) to
  // qualify, since the home-systems entries don't apply to them.
  const inv = safeJson(invRaw) || {};
  function filled(obj, fields) {
    if (!obj || typeof obj !== "object") return false;
    return fields.some((f) => obj[f] != null && obj[f] !== "");
  }
  // Load housing context to narrow the gate for renters.
  let housing = null;
  try {
    const rawProfile = await redis.get(`household:${householdId}:profile`);
    const profile = safeJson(rawProfile);
    housing = profile?.housing || null;
  } catch { /* skip */ }
  const personalOnly = housing === "rent" || housing === "living_with_family";

  let count = 0;
  if (!personalOnly) {
    if (filled(inv.roof, ["material", "yearInstalled", "lastInspected"])) count++;
    if (filled(inv.hvac, ["brand", "yearInstalled", "lastServiced", "filterSize"])) count++;
    if (filled(inv.waterHeater, ["yearInstalled", "type"])) count++;
    if (filled(inv.electrical, ["panelAmps", "yearUpdated"])) count++;
    if (inv.homeBuiltYear != null && inv.homeBuiltYear !== "") count++;
  }
  if (Array.isArray(inv.vehicles) && inv.vehicles.length > 0) count++;
  if (Array.isArray(inv.appliances) && inv.appliances.length > 0) count++;
  const hasInventory = count >= 1;

  // Existing plan blocks new offer unless it's older than 365 days.
  let planTooOld = true;
  if (plan && plan.generatedAt) {
    const age = Date.now() - Date.parse(plan.generatedAt);
    if (!isNaN(age) && age < 365 * 24 * 60 * 60 * 1000) planTooOld = false;
  } else if (!plan) {
    planTooOld = true; // no plan yet
  }

  const offerReady = hasInventory && planTooOld && !offerDismissed;
  return { plan, offerReady, offerDismissed, inventoryItemsKnown: count };
}

export async function isMaintenanceOfferReady(householdId) {
  try {
    const { offerReady } = await evaluateOfferReady(householdId);
    return !!offerReady;
  } catch {
    return false;
  }
}

// ---------- Plan generation ----------

async function generatePlan(userId, householdId) {
  const [
    invRaw, locationStored, signalsRaw, providersHashRaw, profileRaw,
  ] = await Promise.all([
    redis.get(`household:${householdId}:inventory`),
    loadHouseholdLocation(householdId),
    redis.lrange(`household:${householdId}:signals`, 0, -1).catch(() => []),
    redis.hgetall(`household:${householdId}:providers`).catch(() => null),
    redis.get(`household:${householdId}:profile`).catch(() => null),
  ]);
  const inventory = safeJson(invRaw) || {};
  const location = locationStored || LOCATION_FALLBACK;
  const marketRegion = location.marketRegion || "south_florida";
  const profile = safeJson(profileRaw) || {};
  const isRenter = profile.housing === "rent";
  const isLivingWith = profile.housing === "living_with_family";

  // Pull recent service-history from the signal stream — last 90
  // days of resolved/expired service-typed signals gives the model
  // a sense of cadence the household has actually run.
  const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
  const recentService = (signalsRaw || [])
    .map(safeJson).filter(Boolean)
    .filter((s) =>
      (s.type === "service" || s.type === "appointment") &&
      typeof s.id === "number" &&
      Date.now() - s.id < NINETY_DAYS_MS
    )
    .slice(0, 20)
    .map((s) => ({ description: s.description, sender: s.sender, eta: s.eta }));

  // Provider directory — { normalizedName: { name, serviceType,
  // phone, ... } }. Pass through trimmed.
  const providers = [];
  if (providersHashRaw && typeof providersHashRaw === "object") {
    for (const v of Object.values(providersHashRaw)) {
      const p = safeJson(v);
      if (p && p.name) {
        providers.push({
          name: p.name,
          serviceType: p.serviceType || null,
          phone: p.phone || null,
        });
      }
    }
  }

  const ratesBlock = renderRatesForPrompt(marketRegion);
  const cityLabel = location.city
    ? `${location.city}${location.state ? ", " + location.state : ""}`
    : "Fort Lauderdale, FL";

  const renterDirective = isRenter
    ? `\n\nIMPORTANT — RENTER HOUSEHOLD: This household rents their home. Generate a maintenance plan covering ONLY:\n- Their personal appliances (refrigerator, washer/dryer, dishwasher only if listed in inventory)\n- Their vehicles (if any in inventory)\n- Their lease renewal timing (use any lease data passed in signals)\n- Renter's insurance renewal\n- General personal maintenance (vehicle service, subscriptions, health)\n\nDo NOT include: roof, HVAC, water heater, electrical, structural items, pool, lawn (unless tenant-responsible per lease), pest control (unless tenant-responsible).\n\nTitle the plan internally as 'Your Maintenance Plan' (mobile renders the header).\n`
    : isLivingWith
    ? `\n\nIMPORTANT — LIVING WITH FAMILY: This household does not own or rent independently. Skip ALL home-related items. Include only personal items (vehicles, subscriptions, health). Quiet months are expected.\n`
    : "";
  const prompt = `Generate a 12-month ${isRenter || isLivingWith ? "personal" : "home"} maintenance plan for this household. Return ONLY the structured JSON via the tool — no commentary.${renterDirective}

HOUSEHOLD:
Location: ${cityLabel} (market region: ${marketRegion})
Home built: ${inventory.homeBuiltYear || "unknown"}
Roof: ${JSON.stringify(inventory.roof || {})}
HVAC: ${JSON.stringify(inventory.hvac || {})}
Water heater: ${JSON.stringify(inventory.waterHeater || {})}
Electrical: ${JSON.stringify(inventory.electrical || {})}
Vehicles: ${JSON.stringify(inventory.vehicles || [])}
Appliances: ${JSON.stringify(inventory.appliances || [])}
Known providers: ${JSON.stringify(providers)}
Recent service history (last 90d): ${JSON.stringify(recentService)}

MARKET RATES (use these for cost estimates):
${ratesBlock}

Cover the next 12 calendar months starting this month. Keep each month to 2-4 items max — only the genuinely-due tasks plus key seasonal items. Quiet months can have 0-2 items.

Partial-data handling: skip categories where no inventory data is available rather than inventing items. For example, if no roof information is present, leave roof out of the plan entirely. Use the householdNotes array to call out which missing data would round out coverage (e.g., "No roof history provided — adding install year would let Conductor schedule inspections appropriately"). The plan stays useful with whatever inventory exists. Use the rates above for costLow/costHigh estimates — don't invent prices outside that range. If a known provider exists for a service type, populate knownProvider + providerPhone; otherwise null. diyPossible only when the task is realistically homeowner-feasible (filter change, drain check) — not roof replacement or AC service.

${marketRegion === "south_florida" ? `Fort Lauderdale specifics:
- Hurricane prep season May-June: roof inspection, tree trimming, generator service
- Rainy season June-October: drainage, gutters, pest control intensified
- HVAC critical June-September — book service early, premium pricing
- No heating season — skip furnace items
- Pool service year-round
- Pest control quarterly` : ""}

Also produce:
- monthly + annual budget bands (sum of cost ranges across all months / 12 for monthly avg)
- peakMonths (3 most expensive)
- quietMonths (3 cheapest)
- 1-3 household notes calling out major-cost things looming (e.g. "HVAC is N years old — replacement window approaching")`;

  const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      // Haiku here, not Sonnet, despite the spec naming Sonnet —
      // the per-Vercel-function 60s budget can't accommodate
      // Sonnet's full 12-month tool_use response in a single call.
      // Haiku is more than capable: the task is structured
      // pattern-matching against the market rates we provide.
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4500,
      tools: [
        {
          name: "record_maintenance_plan",
          description: "Record the household's 12-month maintenance plan with budget summary and household-specific notes.",
          input_schema: {
            type: "object",
            properties: {
              months: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    month: { type: "string" },
                    items: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          category: {
                            type: "string",
                            enum: ["hvac", "roof", "lawn", "pest", "pool", "vehicle", "plumbing", "electrical", "appliance", "general"],
                          },
                          task: { type: "string" },
                          reason: { type: "string" },
                          priority: { type: "string", enum: ["urgent", "recommended", "optional"] },
                          costLow: { type: "number" },
                          costHigh: { type: "number" },
                          unit: { type: "string", enum: ["one-time", "monthly", "quarterly"] },
                          knownProvider: { type: ["string", "null"] },
                          providerPhone: { type: ["string", "null"] },
                          diyPossible: { type: "boolean" },
                        },
                        required: ["category", "task", "reason", "priority", "costLow", "costHigh", "unit", "diyPossible"],
                      },
                    },
                  },
                  required: ["month", "items"],
                },
              },
              budget: {
                type: "object",
                properties: {
                  monthlyAverage: { type: "number" },
                  monthlyLow: { type: "number" },
                  monthlyHigh: { type: "number" },
                  annualLow: { type: "number" },
                  annualHigh: { type: "number" },
                  peakMonths: { type: "array", items: { type: "string" } },
                  quietMonths: { type: "array", items: { type: "string" } },
                },
                required: ["monthlyAverage", "annualLow", "annualHigh"],
              },
              householdNotes: { type: "array", items: { type: "string" } },
            },
            required: ["months", "budget"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "record_maintenance_plan" },
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!apiRes.ok) {
    const text = await apiRes.text().catch(() => "");
    console.error("[maintenance] sonnet error", apiRes.status, text.slice(0, 200));
    throw new Error(`Sonnet ${apiRes.status}`);
  }
  const data = await apiRes.json();
  const toolBlock = (data?.content || []).find((b) => b?.type === "tool_use");
  if (!toolBlock || !toolBlock.input) {
    throw new Error("no tool_use block in maintenance response");
  }
  const plan = {
    generatedAt: new Date().toISOString(),
    location: cityLabel,
    months: toolBlock.input.months || [],
    budget: toolBlock.input.budget || {},
    householdNotes: toolBlock.input.householdNotes || [],
  };

  await redis.set(
    `household:${householdId}:maintenancePlan`,
    JSON.stringify(plan),
    { ex: ONE_YEAR_SEC }
  );
  return plan;
}

// ---------- Handler ----------

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method === "GET") {
    const { userId } = req.query || {};
    if (!userId) return res.status(400).json({ error: "userId required" });
    const householdId = await resolveHouseholdId(userId);
    if (!householdId) return res.status(400).json({ error: "no household" });
    const { plan, offerReady, offerDismissed, inventoryItemsKnown } =
      await evaluateOfferReady(householdId);
    return res.status(200).json({
      household: householdId,
      plan,
      offerReady,
      offerDismissed,
      inventoryItemsKnown,
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const action = req.body?.action || req.query?.action;
  const userId = req.body?.userId || req.query?.userId;
  if (!userId) return res.status(400).json({ error: "userId required" });
  const householdId = await resolveHouseholdId(userId);
  if (!householdId) return res.status(400).json({ error: "no household" });

  if (action === "dismiss") {
    await redis.set(`household:${householdId}:maintenanceOfferDismissed`, "true");
    return res.status(200).json({ ok: true, dismissed: true });
  }

  if (action === "generate") {
    try {
      const plan = await generatePlan(userId, householdId);
      return res.status(200).json({ ok: true, plan });
    } catch (err) {
      console.error("[maintenance] generate failed:", err);
      return res.status(500).json({ error: "Plan generation failed", message: err?.message });
    }
  }

  if (action === "addToRadar") {
    const { task, month, category, costLow, costHigh } = req.body || {};
    if (!task || !month) return res.status(400).json({ error: "task and month required" });
    // Parse "June 2026" → first-of-month ISO date.
    const monthMs = Date.parse(`${month} 1, ${(month.match(/\d{4}/) || [""])[0]}`)
                  || Date.parse(`${month} 1`);
    const etaISO = !isNaN(monthMs) ? new Date(monthMs).toISOString().slice(0, 10) : null;
    const signal = {
      id: Date.now() + Math.floor(Math.random() * 1000),
      description: `${task} — ${month}`,
      type: "service",
      state: "incoming",
      eta: etaISO,
      source: "maintenance_plan",
      lastUpdate: new Date().toLocaleString(),
      category: category || null,
      estimatedCost: {
        low: typeof costLow === "number" ? costLow : null,
        high: typeof costHigh === "number" ? costHigh : null,
      },
      userId,
    };
    await redis.lpush(`household:${householdId}:signals`, JSON.stringify(signal));
    return res.status(200).json({ ok: true, signalId: signal.id });
  }

  return res.status(400).json({ error: "Unknown action — use generate|dismiss|addToRadar" });
}
