// One-shot stale-signal cleanup for household:RangerOaks925:signals.
//
// Dry-run by default — pass `--apply` to actually rewrite the list.
//
// Criteria (per request, with adaptations noted inline):
//   1. ETA in the past by >48h AND state in {incoming, active}. Original spec
//      also required `no resolvedAt field` — every signal in the list lacks
//      that field today, so it's a no-op conjunct.
//   2. type === "unknown" AND status === "Unknown" AND eta == null AND
//      confidence < 4 (numeric). No signals currently have type === "unknown",
//      so this rule matches zero — kept for completeness.
//   3. Test-run residue: sender or description matches /test/i.

import { readFileSync } from "fs";
import { Redis } from "@upstash/redis";

const envFile = readFileSync(".env.production.local", "utf-8");
for (const line of envFile.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const APPLY = process.argv.includes("--apply");
const KEY = "household:RangerOaks925:signals";
const DAY_MS = 24 * 60 * 60 * 1000;
const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;
const FIVE_DAYS_MS = 5 * DAY_MS;

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v);

// Extract a date out of permissive ETA strings: "2026-05-07 at 6:30 PM",
// "2026-05-06 to 2026-05-13", "tomorrow", "unknown". For range strings we
// take the LATER bound — the signal is only stale once the whole range
// has passed.
function leniencyParse(eta) {
  if (typeof eta !== "string" || !eta) return null;
  const all = [...eta.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)];
  if (all.length === 0) return null;
  const last = all[all.length - 1][0];
  const ms = Date.parse(last);
  return isNaN(ms) ? null : ms;
}

const raws = await redis.lrange(KEY, 0, -1);
console.log(`read ${raws.length} signals from ${KEY}`);

const survivors = [];
const removals = [];

const now = Date.now();

for (const raw of raws) {
  let s;
  try {
    s = parse(raw);
  } catch {
    survivors.push(raw);
    continue;
  }
  const reasons = [];

  // Criterion 1: past ETA + still incoming/active. Uses leniencyParse so
  // malformed-but-dated strings like "2026-05-07 at 6:30 PM" and ranges
  // like "2026-05-06 to 2026-05-13" are correctly classified as past.
  if ((s.state === "incoming" || s.state === "active") && s.eta) {
    const etaMs = leniencyParse(s.eta);
    if (etaMs !== null && now - etaMs > FORTY_EIGHT_HOURS_MS) {
      const daysPast = Math.round((now - etaMs) / DAY_MS);
      reasons.push(`stale-${s.state} (eta ${s.eta} = ${daysPast}d ago)`);
    }
  }

  // Criterion 2: unknown / Unknown / no eta / confidence < 4
  if (
    s.type === "unknown" &&
    s.status === "Unknown" &&
    (s.eta == null || s.eta === "") &&
    typeof s.confidence === "number" &&
    s.confidence < 4
  ) {
    reasons.push("low-confidence-blank");
  }

  // Criterion 3: test-run residue
  const senderHit = typeof s.sender === "string" && /test/i.test(s.sender);
  const descHit = typeof s.description === "string" && /test/i.test(s.description);
  if (senderHit || descHit) {
    reasons.push(`test-residue (${senderHit ? "sender" : ""}${senderHit && descHit ? "+" : ""}${descHit ? "desc" : ""})`);
  }

  // Criterion 4: terminal-state signals with ETA past by >5 days. Catches
  // duplicated/expired/resolved old appointments that pile up (e.g. the
  // OrganikTan spray-tan group, six signals for the same 5/7 appointment
  // in expired+resolved states). The clearance brief surfaces these as
  // "still hanging open" stale items; once they're old enough they're
  // no longer brief-relevant.
  if ((s.state === "expired" || s.state === "resolved") && s.eta) {
    const etaMs = leniencyParse(s.eta);
    if (etaMs !== null && now - etaMs > FIVE_DAYS_MS) {
      const daysPast = Math.round((now - etaMs) / DAY_MS);
      reasons.push(`old-${s.state} (eta ${s.eta} = ${daysPast}d ago)`);
    }
  }

  if (reasons.length > 0) {
    removals.push({ s, reasons });
  } else {
    survivors.push(JSON.stringify(s));
  }
}

console.log();
console.log(`would remove: ${removals.length}`);
console.log(`would keep:   ${survivors.length}`);
console.log();

// Group removals by reason for a tidy summary
const byReason = new Map();
for (const r of removals) {
  for (const reason of r.reasons) {
    const tag = reason.split(" ")[0];
    byReason.set(tag, (byReason.get(tag) || 0) + 1);
  }
}
console.log("by reason:");
for (const [tag, count] of byReason) console.log(`  ${tag}: ${count}`);
console.log();

console.log("--- removals ---");
for (const { s, reasons } of removals) {
  const desc = (s.description || "(no description)").slice(0, 70);
  const sender = (s.sender || "(no sender)").slice(0, 30);
  console.log(`[${reasons.join(", ")}]`);
  console.log(`  id=${s.id} state=${s.state} type=${s.type} eta=${s.eta || "null"}`);
  console.log(`  from=${sender}`);
  console.log(`  desc=${desc}`);
}

if (!APPLY) {
  console.log();
  console.log("DRY RUN — pass --apply to rewrite the list");
  process.exit(0);
}

// Apply: atomic DEL + RPUSH survivors. Small window where the list is empty
// is acceptable for a one-shot cleanup; brief.js's read tolerates an empty
// list (renders "no signals" copy).
console.log();
console.log("APPLYING — DEL + RPUSH survivors");
await redis.del(KEY);
if (survivors.length > 0) {
  // Upstash @upstash/redis accepts variadic args via spread for rpush.
  // Chunk to avoid request-size limits even though 128 items easily fits.
  const CHUNK = 50;
  for (let i = 0; i < survivors.length; i += CHUNK) {
    await redis.rpush(KEY, ...survivors.slice(i, i + CHUNK));
  }
}
const after = await redis.lrange(KEY, 0, -1);
console.log(`final list size: ${after.length}`);
