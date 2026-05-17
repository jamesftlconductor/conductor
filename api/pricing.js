// Market-aware service pricing reference. Consumed by api/ask.js when
// answering cost-related household questions, and (future) by the
// home-services build for price context in provider recommendations.
//
// Per-market structure: services map service-type → { lowRange, highRange,
// unit, notes }. Seasonal notes are returned separately so the caller can
// surface the relevant one based on the current month.
//
// Non-public module — direct hits return 404.

const PRICING_BY_REGION = {
  nyc: {
    label: "New York City",
    services: {
      hvac_tuneup:        { low: 150,  high: 250,   unit: "service",  notes: "" },
      hvac_replacement:   { low: 6000, high: 12000, unit: "system",   notes: "" },
      plumbing_first_hour:{ low: 250,  high: 400,   unit: "hour",     notes: "First hour; additional time billed separately" },
      water_heater:       { low: 1200, high: 2500,  unit: "install",  notes: "" },
      electrical_first_hour:{ low: 300,high: 500,   unit: "hour",     notes: "First hour" },
      electrical_panel:   { low: 2500, high: 5000,  unit: "panel",    notes: "" },
      roof_inspection:    { low: 300,  high: 600,   unit: "inspection",notes: "" },
      roof_replacement:   { low: 15000,high: 40000, unit: "roof",     notes: "" },
      painting_interior:  { low: 500,  high: 1200,  unit: "room",     notes: "" },
      painting_exterior:  { low: 6000, high: 15000, unit: "house",    notes: "" },
      handyman:           { low: 100,  high: 200,   unit: "hour",     notes: "" },
      pest_control:       { low: 200,  high: 400,   unit: "quarter",  notes: "" },
    },
    seasonal: {
      heating: { months: [10, 11, 0, 1, 2, 3], note: "Heating season (Oct-Apr) — furnace service in higher demand" },
      cooling: { months: [5, 6, 7, 8],         note: "AC season (Jun-Sep) — book early to avoid peak" },
    },
  },

  south_florida: {
    label: "South Florida",
    services: {
      hvac_tuneup:        { low: 100,  high: 175,   unit: "service",  notes: "" },
      hvac_replacement:   { low: 5000, high: 9500,  unit: "system",   notes: "" },
      plumbing_first_hour:{ low: 175,  high: 300,   unit: "hour",     notes: "" },
      water_heater:       { low: 900,  high: 1800,  unit: "install",  notes: "" },
      electrical_first_hour:{ low: 200,high: 350,   unit: "hour",     notes: "" },
      electrical_panel:   { low: 2000, high: 4000,  unit: "panel",    notes: "" },
      roof_inspection:    { low: 150,  high: 400,   unit: "inspection",notes: "" },
      roof_replacement:   { low: 12000,high: 30000, unit: "roof",     notes: "Hurricane straps + permitting add to cost" },
      painting_interior:  { low: 350,  high: 800,   unit: "room",     notes: "" },
      painting_exterior:  { low: 5000, high: 12000, unit: "house",    notes: "" },
      handyman:           { low: 75,   high: 140,   unit: "hour",     notes: "" },
      pest_control:       { low: 100,  high: 250,   unit: "quarter",  notes: "" },
    },
    seasonal: {
      cooling: { months: [5, 6, 7, 8],         note: "AC year-round; summer premium (Jun-Sep) — book maintenance in spring" },
      hurricane: { months: [4, 5],             note: "Hurricane prep season (May-Jun) — roof inspections and shutter installs in demand" },
    },
  },

  chicago: {
    label: "Chicago",
    services: {
      hvac_tuneup:        { low: 100,  high: 175,   unit: "service",  notes: "" },
      hvac_replacement:   { low: 5000, high: 10000, unit: "system",   notes: "" },
      plumbing_first_hour:{ low: 200,  high: 350,   unit: "hour",     notes: "" },
      water_heater:       { low: 1000, high: 2200,  unit: "install",  notes: "" },
      electrical_first_hour:{ low: 250,high: 400,   unit: "hour",     notes: "" },
      electrical_panel:   { low: 2200, high: 4500,  unit: "panel",    notes: "" },
      roof_inspection:    { low: 200,  high: 500,   unit: "inspection",notes: "" },
      roof_replacement:   { low: 10000,high: 25000, unit: "roof",     notes: "" },
      painting_interior:  { low: 400,  high: 900,   unit: "room",     notes: "" },
      painting_exterior:  { low: 5500, high: 13000, unit: "house",    notes: "" },
      handyman:           { low: 80,   high: 150,   unit: "hour",     notes: "" },
      pest_control:       { low: 175,  high: 350,   unit: "quarter",  notes: "" },
    },
    seasonal: {
      heating: { months: [10, 11, 0, 1, 2, 3], note: "Heating season (Oct-Apr); emergency rates Dec-Feb when furnaces fail in subzero weather" },
      cooling: { months: [5, 6, 7],            note: "AC season (Jun-Aug)" },
    },
  },

  los_angeles: {
    label: "Los Angeles",
    services: {
      hvac_tuneup:        { low: 120,  high: 200,   unit: "service",  notes: "" },
      hvac_replacement:   { low: 5500, high: 11000, unit: "system",   notes: "" },
      plumbing_first_hour:{ low: 200,  high: 375,   unit: "hour",     notes: "" },
      water_heater:       { low: 1100, high: 2300,  unit: "install",  notes: "" },
      electrical_first_hour:{ low: 275,high: 450,   unit: "hour",     notes: "" },
      electrical_panel:   { low: 2400, high: 4800,  unit: "panel",    notes: "" },
      roof_inspection:    { low: 250,  high: 500,   unit: "inspection",notes: "" },
      roof_replacement:   { low: 12000,high: 30000, unit: "roof",     notes: "" },
      painting_interior:  { low: 450,  high: 1000,  unit: "room",     notes: "" },
      painting_exterior:  { low: 5500, high: 13000, unit: "house",    notes: "" },
      handyman:           { low: 90,   high: 175,   unit: "hour",     notes: "" },
      pest_control:       { low: 175,  high: 375,   unit: "quarter",  notes: "" },
    },
    seasonal: {
      wildfire: { months: [8, 9, 10], note: "Wildfire season (Sep-Nov) — brush clearing and roof inspection demand surges" },
    },
  },

  seattle: {
    label: "Seattle",
    services: {
      hvac_tuneup:        { low: 100,  high: 175,   unit: "service",  notes: "Heat pump tune-ups dominate; furnace less common" },
      hvac_replacement:   { low: 5000, high: 10000, unit: "system",   notes: "Heat pump preferred over furnace" },
      plumbing_first_hour:{ low: 200,  high: 350,   unit: "hour",     notes: "" },
      water_heater:       { low: 1000, high: 2200,  unit: "install",  notes: "" },
      electrical_first_hour:{ low: 250,high: 425,   unit: "hour",     notes: "" },
      electrical_panel:   { low: 2300, high: 4600,  unit: "panel",    notes: "" },
      roof_inspection:    { low: 200,  high: 450,   unit: "inspection",notes: "" },
      roof_replacement:   { low: 10000,high: 22000, unit: "roof",     notes: "" },
      painting_interior:  { low: 400,  high: 900,   unit: "room",     notes: "" },
      painting_exterior:  { low: 5000, high: 12000, unit: "house",    notes: "" },
      handyman:           { low: 85,   high: 160,   unit: "hour",     notes: "" },
      pest_control:       { low: 150,  high: 350,   unit: "quarter",  notes: "" },
    },
    seasonal: {
      wet: { months: [9, 10, 11, 0, 1, 2, 3], note: "Rainy season (Oct-Apr) — gutter cleaning, roof, and moss treatment in demand" },
    },
  },

  boston: {
    label: "Boston",
    services: {
      hvac_tuneup:        { low: 120,  high: 200,   unit: "service",  notes: "" },
      hvac_replacement:   { low: 5500, high: 11000, unit: "system",   notes: "" },
      plumbing_first_hour:{ low: 225,  high: 375,   unit: "hour",     notes: "" },
      water_heater:       { low: 1100, high: 2300,  unit: "install",  notes: "" },
      electrical_first_hour:{ low: 275,high: 450,   unit: "hour",     notes: "" },
      electrical_panel:   { low: 2400, high: 4800,  unit: "panel",    notes: "" },
      roof_inspection:    { low: 250,  high: 500,   unit: "inspection",notes: "" },
      roof_replacement:   { low: 12000,high: 28000, unit: "roof",     notes: "" },
      painting_interior:  { low: 450,  high: 1000,  unit: "room",     notes: "" },
      painting_exterior:  { low: 5500, high: 13000, unit: "house",    notes: "" },
      handyman:           { low: 90,   high: 175,   unit: "hour",     notes: "" },
      pest_control:       { low: 175,  high: 375,   unit: "quarter",  notes: "" },
    },
    seasonal: {
      heating: { months: [10, 11, 0, 1, 2, 3], note: "Heating season (Oct-Apr)" },
      cooling: { months: [5, 6, 7],            note: "AC season (Jun-Aug)" },
      ice_damage: { months: [1, 2],            note: "Ice dam / snow damage season (Feb-Mar) — roof and gutter repair demand" },
    },
  },

  miami: null, // Falls through to south_florida via getServicePricing alias.

  generic: {
    label: "your area",
    services: {
      hvac_tuneup:        { low: 100,  high: 250,   unit: "service",  notes: "National range; verify locally" },
      hvac_replacement:   { low: 5000, high: 12000, unit: "system",   notes: "National range; varies significantly" },
      plumbing_first_hour:{ low: 175,  high: 400,   unit: "hour",     notes: "" },
      water_heater:       { low: 900,  high: 2500,  unit: "install",  notes: "" },
      electrical_first_hour:{ low: 200,high: 500,   unit: "hour",     notes: "" },
      electrical_panel:   { low: 2000, high: 5000,  unit: "panel",    notes: "" },
      roof_inspection:    { low: 150,  high: 600,   unit: "inspection",notes: "" },
      roof_replacement:   { low: 10000,high: 40000, unit: "roof",     notes: "" },
      painting_interior:  { low: 350,  high: 1200,  unit: "room",     notes: "" },
      painting_exterior:  { low: 5000, high: 15000, unit: "house",    notes: "" },
      handyman:           { low: 75,   high: 200,   unit: "hour",     notes: "" },
      pest_control:       { low: 100,  high: 400,   unit: "quarter",  notes: "" },
    },
    seasonal: {},
  },
};

// Format helper. "low-high range per unit" — used inline in prompts.
function rangeStr(s) {
  if (!s) return null;
  return `$${s.low.toLocaleString()}-${s.high.toLocaleString()}/${s.unit}`;
}

// Returns the pricing block for a market region. Falls back to
// generic for unknown markets, and aliases miami → south_florida.
export function getServicePricing(marketRegion) {
  const key = marketRegion === "miami" ? "south_florida" : marketRegion;
  return PRICING_BY_REGION[key] || PRICING_BY_REGION.generic;
}

// Returns the seasonal note(s) currently in effect for the given
// market based on today's month. Empty array when nothing seasonal
// applies right now.
export function getCurrentSeasonalNotes(marketRegion, today = new Date()) {
  const pricing = getServicePricing(marketRegion);
  const month = today.getMonth();
  const notes = [];
  for (const entry of Object.values(pricing.seasonal || {})) {
    if (Array.isArray(entry.months) && entry.months.includes(month)) {
      notes.push(entry.note);
    }
  }
  return notes;
}

// Render a compact pricing reference suitable for embedding in a
// Claude prompt. Skips service rows the caller didn't ask for; pass
// null/undefined `serviceKeys` to emit the full table.
export function renderPricingForPrompt(marketRegion, serviceKeys) {
  const pricing = getServicePricing(marketRegion);
  const lines = [`Service pricing for ${pricing.label}:`];
  const keys = Array.isArray(serviceKeys) && serviceKeys.length > 0
    ? serviceKeys
    : Object.keys(pricing.services);
  for (const k of keys) {
    const s = pricing.services[k];
    if (!s) continue;
    const range = rangeStr(s);
    const label = k.replace(/_/g, " ");
    lines.push(`- ${label}: ${range}${s.notes ? ` — ${s.notes}` : ""}`);
  }
  const seasonal = getCurrentSeasonalNotes(marketRegion);
  if (seasonal.length > 0) {
    lines.push("");
    lines.push("Seasonal context:");
    for (const note of seasonal) lines.push(`- ${note}`);
  }
  return lines.join("\n");
}

export default function handler(req, res) {
  return res.status(404).json({ error: "Not a public endpoint" });
}
