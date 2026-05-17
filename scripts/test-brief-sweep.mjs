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

function check(text) {
  WINDOW_PHRASE_RE.lastIndex = 0;
  GAP_PHRASE_RE.lastIndex = 0;
  WEATHER_CLOSER_RE.lastIndex = 0;
  POSITIVE_HEALTH_RE.lastIndex = 0;
  if (WINDOW_PHRASE_RE.test(text)) return "window";
  if (GAP_PHRASE_RE.test(text)) return "gap";
  if (WEATHER_CLOSER_RE.test(text)) return "weather";
  if (POSITIVE_HEALTH_RE.test(text)) return "health";
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
];

let pass = 0, fail = 0;
for (const [text, expected] of cases) {
  const got = check(text);
  const ok = got === expected;
  if (ok) pass++; else fail++;
  const mark = ok ? "PASS" : "FAIL";
  console.log(`${mark}  ${JSON.stringify(text).padEnd(58)}  expected=${expected.padEnd(8)} got=${got}`);
}
console.log();
console.log(`Total: ${cases.length} | Pass: ${pass} | Fail: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
