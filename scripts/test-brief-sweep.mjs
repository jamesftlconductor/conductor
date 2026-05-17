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
const UNTIL_IN_RE = /\buntil in\b/gi;
const INVENTED_DATE_RANGE_RE = /\b(sometime between\b|expected sometime\b|by the end of (?:the |this )?(?:year|month|quarter|week)\b|around the (?:end|middle|start) of (?:the |this )?(?:year|month|quarter|season|january|february|march|april|may|june|july|august|september|october|november|december)\b|in the (?:next|coming) (?:month|quarter|season) or so\b)/gi;

const TRANSPARENCY_HEALTH_NUMBER_RE = /\b\d+(?:\.\d+)?\s*(?:steps|calories|kcal|bpm|ms|hours?\s+of\s+sleep|hrs?\s+of\s+sleep|hours?\s+slept|hrs?\s+slept)\b/gi;
const TRANSPARENCY_HEALTH_PCT_RE = /\b\d+%\s+(?:below|above|of|under|over)\s+(?:baseline|normal|average|usual|typical)\b/gi;

const HORIZON_CLOSER_RE = /\b(worth watching|on the radar|conductor has its eye on this|watching for it|we'?ll flag it when it matters)\b/gi;
const INLINE_DAYCOUNT_RE = /\bin\s+(\d+)\s+(day|days|week|weeks)\b/gi;
const NEAR_KEYWORDS_RE = /\b(today|tomorrow|tonight|this (?:morning|afternoon|evening|week|weekend))\b/gi;
const MONTH_DAY_RE = /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan\.?|Feb\.?|Mar\.?|Apr\.?|Jun\.?|Jul\.?|Aug\.?|Sept?\.?|Oct\.?|Nov\.?|Dec\.?)\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi;
const ORDINAL_DAY_RE = /\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/gi;

function ordinalDayToDays(dayStr, today) {
  const day = parseInt(dayStr, 10);
  if (!day || day < 1 || day > 31) return null;
  const todayDay = today.getDate();
  const year = today.getFullYear();
  const month = today.getMonth();
  const candidateMonth = day >= todayDay ? month : month + 1;
  const target = new Date(year, candidateMonth, day);
  if (isNaN(target.getTime())) return null;
  if (target.getDate() !== day) return null;
  const startOfToday = new Date(year, month, todayDay);
  return Math.round((target.getTime() - startOfToday.getTime()) / 86400000);
}

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
    if (!evidence) {
      ORDINAL_DAY_RE.lastIndex = 0;
      let od;
      while ((od = ORDINAL_DAY_RE.exec(sentence)) !== null) {
        const days = ordinalDayToDays(od[1], today);
        if (days != null && days >= 0 && days <= 14) { evidence = od[0]; break; }
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
  WINDOW_PHRASE_RE.lastIndex = 0;
  UNTIL_IN_RE.lastIndex = 0;
  INVENTED_DATE_RANGE_RE.lastIndex = 0;
  if (WINDOW_PHRASE_RE.test(text)) return "window";
  if (GAP_PHRASE_RE.test(text)) return "gap";
  if (WEATHER_CLOSER_RE.test(text)) return "weather";
  if (HYDRATION_NUDGE_RE.test(text)) return "hydration";
  if (POSITIVE_HEALTH_RE.test(text)) return "health";
  if (UNTIL_IN_RE.test(text)) return "until_in";
  if (INVENTED_DATE_RANGE_RE.test(text)) return "invented_date_range";
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

  // Bare ordinal day-of-month near-window (TODAY=May 17)
  ["Your Google Home renewal on the 28th is worth watching.", "horizon_near"],   // 11 days
  ["The renewal on the 18th is worth watching.", "horizon_near"],                // 1 day
  ["The renewal on the 17th is worth watching.", "horizon_near"],                // 0 days
  ["The renewal on the 31st is worth watching.", "horizon_near"],                // 14 days
  // Bare ordinal day-of-month past 14-day window — must stay CLEAN
  ["The renewal on the 4th is worth watching.", "CLEAN"],                        // June 4 = 18 days
  ["Conductor has its eye on the 1st of next month.", "CLEAN"],                  // June 1 = 15 days

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

  // "until in" glue malformation — must flag
  ["Google Home doesn't come due until in 11 days on Thursday, May 28.", "until_in"],
  ["The lease isn't up until in 2 weeks.", "until_in"],
  // Negative — "until" used naturally without "in N" following
  ["Doesn't come due until Thursday, May 28.", "CLEAN"],
  ["Comes due in 11 days, on Thursday, May 28.", "CLEAN"],

  // Invented date ranges / windows — must flag
  ["Your Chime Card is on its way, expected sometime between mid-December and the end of the year.", "invented_date_range"],
  ["The renewal is expected sometime in fall.", "invented_date_range"],
  ["The package should arrive by the end of the year.", "invented_date_range"],
  ["The work will be done around the end of December.", "invented_date_range"],
  ["The estimate is anywhere from $500 to $1,200.", "CLEAN"], // $ amounts, not dates — should NOT flag
  // Negative — legitimate phrasings stay clean
  ["The package is still in motion — no confirmed date yet.", "CLEAN"],
  ["Conductor is watching for the Chime Card; details still coming through.", "CLEAN"],
  ["Health Tech Nerds renews Wednesday, May 20.", "CLEAN"],
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
