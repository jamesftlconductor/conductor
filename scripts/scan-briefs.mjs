// Standalone scan script — applies the same five sweep checks brief.js
// uses internally to a set of saved brief JSON files. Reusable for
// post-run verification.
//
// Usage: node scripts/scan-briefs.mjs <file1.json> [file2.json ...]

import { readFileSync } from "fs";

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

function sweep(brief, today = new Date()) {
  const hits = [];
  WINDOW_PHRASE_RE.lastIndex = 0;
  GAP_PHRASE_RE.lastIndex = 0;
  WEATHER_CLOSER_RE.lastIndex = 0;
  POSITIVE_HEALTH_RE.lastIndex = 0;
  const w = brief.match(WINDOW_PHRASE_RE);
  if (w) hits.push(`window=[${w.join(", ")}]`);
  const g = brief.match(GAP_PHRASE_RE);
  if (g) hits.push(`gap=[${g.join(", ")}]`);
  const wc = brief.match(WEATHER_CLOSER_RE);
  if (wc) hits.push(`weather=[${wc.join(", ")}]`);
  const ph = brief.match(POSITIVE_HEALTH_RE);
  if (ph) hits.push(`health=[${ph.join(", ")}]`);
  const hcn = horizonNearViolations(brief, today);
  if (hcn.length > 0) hits.push(`horizon_near=[${hcn.join(", ")}]`);
  return hits;
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node scripts/scan-briefs.mjs <file1.json> [file2.json ...]");
  process.exit(1);
}
let clean = 0;
for (const f of files) {
  const d = JSON.parse(readFileSync(f, "utf-8"));
  const hits = sweep(d.brief || "");
  console.log(`===== ${f} =====`);
  console.log(d.brief);
  console.log();
  if (hits.length === 0) {
    console.log("SWEEP: CLEAN");
    clean++;
  } else {
    console.log("SWEEP:", hits.join(" ; "));
  }
  console.log();
}
console.log(`SUMMARY: ${clean} / ${files.length} clean`);
