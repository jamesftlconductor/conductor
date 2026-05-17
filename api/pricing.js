// Market-aware home-services pricing reference. Per-market shape:
//   { label, rates: { <service>: <human-readable range string> },
//     seasonal: <free-text>, humor: [<aside strings>] }
//
// Consumed by api/ask.js (full block embedded into Sonnet's system
// prompt) and (future) the home-services build for provider scoring.
//
// Service slugs are stable across markets even when a market doesn't
// cover one — callers should tolerate a missing key by falling back
// to MARKET_RATES.generic.
//
// Non-public module; direct hits return 404.

export const MARKET_RATES = {
  south_florida: {
    label: "South Florida / Fort Lauderdale",
    rates: {
      hvac: "tune-up $85-150 standard / $120-200 summer premium (June-Sept). Full system $4,000-8,000. Filter change $15-40.",
      plumbing: "service call $150-250 first hour. Water heater installation $800-1,500. Drain cleaning $150-300.",
      electrical: "service call $200-350 first hour. Panel upgrade $1,500-3,000. Ceiling fan $100-250 installed.",
      roofing: "inspection $150-400. Tile replacement $12,000-25,000. Shingle $8,000-15,000. Repair $300-1,500.",
      painting: "interior room $300-700. Whole interior $2,500-6,000. Exterior $3,000-8,000.",
      pool: "monthly service $100-180. Equipment repair $200-600. Resurfacing $3,500-8,000.",
      lawn: "weekly $80-150. Annual fertilization $300-600. Tree trimming $200-800.",
      pest: "quarterly $120-200. Termite treatment $500-2,500.",
      handyman: "$75-150/hour. Half day $300-500.",
      pressure_washing: "driveway $100-200. Whole home $300-600.",
      appliance: "most repairs $150-400. Refrigerator $200-500.",
      windows: "cleaning whole home $150-350. Replacement $300-800/window installed.",
      garage_door: "repair $150-400. Full replacement $800-2,000.",
      duct_cleaning: "$300-600 whole home.",
    },
    seasonal: "Summer (June-Sept): HVAC demand extreme — book 2+ weeks ahead, premium pricing. Hurricane prep (May-June): roof/generator/window quotes spike. Snowbird season (Oct-April): lawn and pool slight premium. Rainy season (June-Oct): roof leaks surface.",
    humor: [
      "another South Florida contractor with a 3-week lead time",
      "summer AC emergency — half of Fort Lauderdale is calling right now",
      "hurricane season pricing in effect",
    ],
  },

  nyc: {
    label: "New York City",
    rates: {
      hvac: "tune-up $150-250. Full system $6,000-12,000. Filter change $20-60.",
      plumbing: "service call $250-400 first hour. Water heater $1,200-2,500. Drain cleaning $200-500.",
      electrical: "service call $300-500 first hour. Panel upgrade $2,500-5,000.",
      roofing: "inspection $300-600. Full replacement $15,000-40,000. Repair $500-3,000.",
      painting: "interior room $500-1,200. Whole interior $4,000-10,000. Exterior $6,000-15,000.",
      lawn: "weekly $150-300 (where applicable). Tree service $500-2,000.",
      pest: "quarterly $200-400. Bed bug treatment $500-1,500.",
      handyman: "$100-200/hour. Half day $450-750.",
      appliance: "most repairs $200-500. Refrigerator $300-600.",
      windows: "cleaning whole home $200-500. Replacement $400-1,000/window.",
      garage_door: "less common — building super typically handles.",
    },
    seasonal: "Heating season (Oct-April): furnace/boiler priority. AC window units June-Aug. Snow/ice damage Feb-March. Building supers handle many repairs — clarify building vs unit responsibility.",
    humor: [
      "NYC contractor — expect 2-4 week lead time minimum",
      "make sure it's your responsibility and not the building's",
      "get it in writing — this is New York",
    ],
  },

  chicago: {
    label: "Chicago",
    rates: {
      hvac: "tune-up $100-175. Full system $5,000-10,000.",
      plumbing: "service call $200-350 first hour. Water heater $900-1,800.",
      electrical: "service call $250-400 first hour. Panel $2,000-4,000.",
      roofing: "inspection $200-500. Replacement $10,000-25,000.",
      painting: "interior room $400-900. Exterior $4,000-10,000.",
      lawn: "weekly $80-150. Snow removal $50-150/visit.",
      pest: "quarterly $150-300.",
      handyman: "$80-150/hour.",
    },
    seasonal: "Heating season (Oct-April): furnace emergency calls Dec-Feb at premium. AC June-Aug. Snow removal Nov-March. Spring flooding common — sump pump maintenance April.",
    humor: [
      "Chicago winter pricing — everyone needs heat at once",
      "get the snow removal contract before November",
    ],
  },

  los_angeles: {
    label: "Los Angeles",
    rates: {
      hvac: "tune-up $120-200. Full system $5,500-11,000.",
      plumbing: "service call $200-375 first hour. Water heater $1,000-2,000.",
      electrical: "service call $275-450 first hour. Panel $2,200-4,500.",
      roofing: "inspection $250-500. Replacement $12,000-30,000.",
      painting: "interior room $450-1,000. Exterior $4,500-12,000.",
      lawn: "weekly $100-200. Tree trimming $300-1,000.",
      pest: "quarterly $150-300.",
      handyman: "$90-175/hour.",
    },
    seasonal: "Wildfire season (Sept-Nov): roofing/brush clearing demand spikes. Earthquake prep year-round. Mild climate means less HVAC urgency. Drought restrictions affect lawn service.",
    humor: [
      "LA contractor — they'll fit you in between shoots",
      "wildfire season pricing in effect",
      "check the drought restrictions before the lawn quote",
    ],
  },

  boston: {
    label: "Boston",
    rates: {
      hvac: "tune-up $120-200. Full system $5,500-11,000.",
      plumbing: "service call $225-375 first hour. Water heater $1,000-2,000.",
      electrical: "service call $275-450 first hour. Panel $2,200-4,500.",
      roofing: "inspection $250-500. Replacement $12,000-28,000.",
      painting: "interior room $450-1,000. Exterior $4,500-11,000.",
      lawn: "weekly $100-175. Snow removal $75-200/visit.",
      pest: "quarterly $150-300.",
      handyman: "$90-175/hour.",
    },
    seasonal: "Heating season (Oct-April): oil/gas furnace priority. AC June-Aug. Ice dam damage Feb-March — roof and gutter critical. Snow removal Nov-April.",
    humor: [
      "Boston contractor — wicked busy until spring",
      "ice dam season — get the roof raked before February",
    ],
  },

  seattle: {
    label: "Seattle",
    rates: {
      hvac: "tune-up $100-175. Heat pump preferred. Full system $5,000-10,000.",
      plumbing: "service call $200-350 first hour. Water heater $900-1,800.",
      electrical: "service call $250-425 first hour. Panel $2,000-4,000.",
      roofing: "inspection $200-450. Replacement $10,000-22,000. Moss treatment $200-600.",
      painting: "interior room $400-900. Exterior $4,000-10,000.",
      lawn: "weekly $80-150. Gutter cleaning $150-300.",
      pest: "quarterly $150-275.",
      handyman: "$85-160/hour.",
    },
    seasonal: "Rainy season (Oct-May): roof, gutter, drainage priority. Moss growth year-round. Rare heat waves July-Aug: AC demand spikes sharply. Mild winters mean less heating urgency than east coast.",
    humor: [
      "Seattle contractor — probably also in a band",
      "moss removal — the Seattle tax",
      "rare sun day — everyone's outside, nobody's fixing anything",
    ],
  },

  miami: null, // Alias to south_florida via getMarketRates below.

  generic: {
    label: "your area",
    rates: {
      hvac: "tune-up $100-200. Full system $5,000-10,000.",
      plumbing: "service call $150-350 first hour.",
      electrical: "service call $200-400 first hour.",
      roofing: "inspection $200-500. Replacement varies widely by region.",
      painting: "interior room $300-900.",
      handyman: "$75-175/hour.",
    },
    seasonal: "Rates vary significantly by region and season. Always get 2-3 quotes.",
    humor: [],
  },
};

// Returns the rates block for a market. Aliases miami → south_florida.
// Falls back to generic when the bucket is unknown.
export function getMarketRates(marketRegion) {
  const key = marketRegion === "miami" ? "south_florida" : marketRegion;
  return MARKET_RATES[key] || MARKET_RATES.generic;
}

// Render the rates block as plain text suitable for embedding in the
// Sonnet system prompt. Header → service: range list → seasonal note.
export function renderRatesForPrompt(marketRegion) {
  const market = getMarketRates(marketRegion);
  const lines = [`HOME SERVICES — ${market.label} market rates:`];
  for (const [service, range] of Object.entries(market.rates)) {
    lines.push(`- ${service}: ${range}`);
  }
  if (market.seasonal) {
    lines.push("");
    lines.push(`SEASONAL NOTES: ${market.seasonal}`);
  }
  return lines.join("\n");
}

// Backwards-compat shim for callers from before the v2 schema. The
// previous shape exposed renderPricingForPrompt(marketRegion); keep
// it as an alias so unrelated paths don't break.
export function renderPricingForPrompt(marketRegion) {
  return renderRatesForPrompt(marketRegion);
}

export default function handler(req, res) {
  return res.status(404).json({ error: "Not a public endpoint" });
}
