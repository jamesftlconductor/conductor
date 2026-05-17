// Unit test for the post-generation sweep regexes. Mirrors the constants
// in api/brief.js verbatim — any divergence here is a copy-paste bug.
//
// Usage: node scripts/test-brief-sweep.mjs

const SPELLED_NUMBERS = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty";
const QUANTIFIERS = "few|several|couple|handful|many|a few|a couple of";
const TIME_UNITS = "day|days|week|weeks|month|months|year|years";

const WINDOW_PHRASE_RE = new RegExp(
  "\\b(in|over|within|across|throughout)\\s+the\\s+(next|coming|upcoming)\\s+" +
  `(?:(${SPELLED_NUMBERS}|${QUANTIFIERS}|\\d+|a|an)\\s+(of\\s+)?)?` +
  `(${TIME_UNITS})\\b`,
  "gi"
);

const GAP_PHRASE_RE = new RegExp(
  `\\b(${SPELLED_NUMBERS}|\\d+|a|${QUANTIFIERS})` +
  `\\s+(${TIME_UNITS})` +
  "\\s+(later|after|ahead|earlier|afterward|subsequently|thereafter|from now|down the line|down the road|out)\\b",
  "gi"
);

const WEATHER_CLOSER_RE = /\b(clear skies( today| ahead)?|otherwise quiet weather|nothing weather-related|the weather'?s calm|the day is clear and warm|with the nice weather|given the calm forecast|weather looks fine)\b/gi;

const POSITIVE_HEALTH_RE = /\b(your body (?:feels?|is|'s) strong|feeling strong|energy is good|in a strong window|strong recovery|recovery looks solid|good timing energy-wise|you're in a strong window)\b/gi;

const HYDRATION_NUDGE_RE = /\b(drink (?:more )?water (?:throughout|today|often|early|all day|regularly)|stay hydrated|hydrate (?:today|early|often|throughout|more|all day|regularly)|keep water (?:close|nearby|handy|on you)|the air (?:is|feels) (?:thick|heavy|sticky|soupy)|heavy air today|humid today|muggy today|thick air|sticky (?:out|today))\b/gi;

const TRANSPARENCY_HEALTH_NUMBER_RE = /\b\d+(?:\.\d+)?\s*(?:steps|calories|kcal|bpm|ms|hours?\s+of\s+sleep|hrs?\s+of\s+sleep|hours?\s+slept|hrs?\s+slept)\b/gi;
const TRANSPARENCY_HEALTH_PCT_RE = /\b\d+%\s+(?:below|above|of|under|over)\s+(?:baseline|normal|average|usual|typical)\b/gi;

const HORIZON_CLOSER_RE = /\b(worth watching|on the radar|conductor has its eye on this|watching for it|we'?ll flag it when it matters)\b/gi;
const INLINE_DAYCOUNT_RE = /\bin\s+(\d+)\s+(day|days|week|weeks)\b/gi;
const NEAR_KEYWORDS_RE = /\b(today|tomorrow|tonight|this (?:morning|afternoon|evening|week|weekend))\b/gi;
const MONTH_DAY_RE = /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan\.?|Feb\.?|Mar\.?|Apr\.?|Jun\.?|Jul\.?|Aug\.?|Sept?\.?|Oct\.?|Nov\.?|Dec\.?)\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi;

function daysFromToday(monthStr, dayStr, today) {
  const cleanMonth = monthStr.replace(/\.$/, "");
  const day = parseInt(dayStr, 10);
  if (isNaN(day)) return null;
  const year = today.getFullYear();
  const thisYear = new Date(`${cleanMonth} ${day}, ${year}`);
  if (isNaN(thisYear.getTime())) return null;
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startOfThisYear = new Date(thisYear.getFullYear(), thisYear.getMonth(), thisYear.getDate());
  const diff = Math.round((startOfThisYear.getTime() - startOfToday.getTime()) / 86400000);
  if (diff < -180) {
    const nextYear = new Date(`${cleanMonth} ${day}, ${year + 1}`);
    if (isNaN(nextYear.getTime())) return diff;
    const startOfNextYear = new Date(nextYear.getFullYear(), nextYear.getMonth(), nextYear.getDate());
    return Math.round((startOfNextYear.getTime() - startOfToday.getTime()) / 86400000);
  }
  return diff;
}

function horizonNearViolations(brief, today) {
  if (!brief) return [];
  const out = [];
  const sentences = brief.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    HORIZON_CLOSER_RE.lastIndex = 0;
    const closer = HORIZON_CLOSER_RE.exec(sentence);
    if (!closer) continue;

    let evidence = null;
    INLINE_DAYCOUNT_RE.lastIndex = 0;
    let dc;
    while ((dc = INLINE_DAYCOUNT_RE.exec(sentence)) !== null) {
      const n = parseInt(dc[1], 10);
      const days = dc[2].toLowerCase().startsWith("week") ? n * 7 : n;
      if (days <= 14) { evidence = dc[0]; break; }
    }
    if (!evidence) {
      NEAR_KEYWORDS_RE.lastIndex = 0;
      const nk = NEAR_KEYWORDS_RE.exec(sentence);
      if (nk) evidence = nk[0];
    }
    if (!evidence) {
      MONTH_DAY_RE.lastIndex = 0;
      let md;
      while ((md = MONTH_DAY_RE.exec(sentence)) !== null) {
        const days = daysFromToday(md[1], md[2], today);
        if (days != null && days >= 0 && days <= 14) { evidence = md[0]; break; }
      }
    }
    if (evidence) out.push(`${closer[1]} → ${evidence}`);
  }
  return out;
}

function check(text, today = new Date()) {
  WINDOW_PHRASE_RE.lastIndex = 0;
  GAP_PHRASE_RE.lastIndex = 0;
  WEATHER_CLOSER_RE.lastIndex = 0;
  HYDRATION_NUDGE_RE.lastIndex = 0;
  POSITIVE_HEALTH_RE.lastIndex = 0;
  if (WINDOW_PHRASE_RE.test(text)) return "window";
  if (GAP_PHRASE_RE.test(text)) return "gap";
  if (WEATHER_CLOSER_RE.test(text)) return "weather";
  if (HYDRATION_NUDGE_RE.test(text)) return "hydration";
  if (POSITIVE_HEALTH_RE.test(text)) return "health";
  if (horizonNearViolations(text, today).length > 0) return "horizon_near";
  return "CLEAN";
}

function checkTransparency(text) {
  TRANSPARENCY_HEALTH_NUMBER_RE.lastIndex = 0;
  TRANSPARENCY_HEALTH_PCT_RE.lastIndex = 0;
  if (TRANSPARENCY_HEALTH_NUMBER_RE.test(text)) return "health_number";
  if (TRANSPARENCY_HEALTH_PCT_RE.test(text)) return "health_pct";
  return "CLEAN";
}

const cases = [
  // Window phrases — must match
  ["in the next 3 days", "window"],
  ["in the next three days", "window"],
  ["in the next few days", "window"],
  ["within the next several weeks", "window"],
  ["over the coming couple of days", "window"],
  ["over the next week", "window"],
  // Gap phrases — must match
  ["eleven days later", "gap"],
  ["11 days later", "gap"],
  ["a few days after", "gap"],
  ["five days from now", "gap"],
  ["two weeks ahead", "gap"],
  // Weather closers — must match
  ["Clear skies today", "weather"],
  ["Otherwise quiet weather", "weather"],
  // Positive health — must match
  ["Your body feels strong today", "health"],
  ["feeling strong", "health"],
  ["energy is good", "health"],
  // Negative cases — must stay CLEAN
  ["Wednesday, May 20 (in 3 days)", "CLEAN"],
  ["Health Tech Nerds renews on Wednesday", "CLEAN"],
  ["The Google Home renewal follows on Thursday, May 28", "CLEAN"],
  ["Mia's field trip to Discovery Museum is tomorrow", "CLEAN"],
  ["renewing in 5 days", "CLEAN"],

  // Horizon-closer eligibility — must match (near-window date with closer)
  ["The Google Home renewal is on the radar due Thursday, May 28.", "horizon_near"],
  ["The renewal is on the radar in 11 days.", "horizon_near"],
  ["The renewal is on the radar tomorrow.", "horizon_near"],
  ["The renewal is on the radar in 2 weeks.", "horizon_near"],
  ["Worth watching: the appointment in 5 days.", "horizon_near"],
  // Horizon-closer eligibility — must stay CLEAN when >14 days
  ["The Paris trip in 30 days is worth watching.", "CLEAN"],
  ["Conductor has its eye on the renewal in 95 days.", "CLEAN"],
  ["Worth watching: the September registration deadline.", "CLEAN"],

  // Hydration / heavy-air nudges — must flag
  ["The air is thick today, so drink water throughout.", "hydration"],
  ["Stay hydrated.", "hydration"],
  ["Hydrate early and pace yourself.", "hydration"],
  ["Keep water close — it's a sticky day out there.", "hydration"],
  ["Heavy air today.", "hydration"],
  ["The air feels heavy.", "hydration"],
  // Negative hydration cases — should stay CLEAN
  ["The renewal needs water before Wednesday.", "CLEAN"],
  ["Don't forget Mia's water bottle for the field trip.", "CLEAN"],
];

const TRANSPARENCY_CASES = [
  // Must flag
  ["the health context shows minimal activity (145 steps, 32 active calories)", "health_number"],
  ["sleep was only 5 hours of sleep last night", "health_number"],
  ["resting HR was 58 bpm", "health_number"],
  ["HRV at 42 ms today", "health_number"],
  ["HRV 15% below baseline", "health_pct"],
  ["recovery is 20% of normal", "health_pct"],
  // Must stay CLEAN — qualitative descriptions are fine
  ["activity is low today", "CLEAN"],
  ["recovery looks light", "CLEAN"],
  ["I included the 3 urgent items because of their deadlines", "CLEAN"],
];

// Use a fixed reference date so month/day tests don't drift across days.
const TODAY = new Date("2026-05-17T12:00:00");

let pass = 0, fail = 0;
console.log("--- BRIEF SWEEP ---");
for (const [text, expected] of cases) {
  const got = check(text, TODAY);
  const ok = got === expected;
  if (ok) pass++; else fail++;
  const mark = ok ? "PASS" : "FAIL";
  console.log(`${mark}  ${JSON.stringify(text).padEnd(68)}  expected=${expected.padEnd(12)} got=${got}`);
}
console.log();
console.log("--- TRANSPARENCY SWEEP ---");
for (const [text, expected] of TRANSPARENCY_CASES) {
  const got = checkTransparency(text);
  const ok = got === expected;
  if (ok) pass++; else fail++;
  const mark = ok ? "PASS" : "FAIL";
  console.log(`${mark}  ${JSON.stringify(text).padEnd(68)}  expected=${expected.padEnd(14)} got=${got}`);
}
const total = cases.length + TRANSPARENCY_CASES.length;
console.log();
console.log(`Total: ${total} | Pass: ${pass} | Fail: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
