// One-shot vault dedup cleanup. Walks the existing vault, applies the
// same word-overlap rule as api/onboard-worker.js, picks the richer
// item per duplicate group, and removes the losers via LREM.
//
// Dry-run by default — prints the planned operations and exits without
// touching Redis. Pass --apply to actually delete.
//
// LREM uses exact-string matching against what LRANGE returned, so each
// removal is a no-op if the data has shifted. Failure mode is safe: a
// partial run leaves the vault consistent but incompletely deduped.
//
// Usage:
//   node scripts/cleanup-vault-duplicates.mjs <householdId>
//   node scripts/cleanup-vault-duplicates.mjs <householdId> --apply

import { readFileSync } from "fs";
import { Redis } from "@upstash/redis";

const envFile = readFileSync(".env.production.local", "utf-8");
for (const line of envFile.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const householdId = process.argv[2];
const apply = process.argv.includes("--apply");
if (!householdId) {
  console.error("usage: node scripts/cleanup-vault-duplicates.mjs <householdId> [--apply]");
  process.exit(1);
}

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const DAY_MS = 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * DAY_MS;

const VAULT_OVERLAP_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "your", "this", "that",
  "you", "are", "was", "will", "has", "have", "been",
  "insurance", "policy", "renewal", "renews", "subscription",
  "membership", "registration", "warranty", "expiration", "expires",
  "service", "plan", "notice", "reminder",
]);

function vaultDescriptionOverlap(a, b) {
  if (!a || !b) return 0;
  const toWords = (s) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !VAULT_OVERLAP_STOPWORDS.has(w))
    );
  const wordsA = toWords(a);
  const wordsB = toWords(b);
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let common = 0;
  for (const w of wordsA) if (wordsB.has(w)) common++;
  return common / Math.min(wordsA.size, wordsB.size);
}

function infoDensity(item) {
  let n = 0;
  if (item.description) n++;
  if (item.provider) n++;
  if (item.renewalDate) n++;
  if (item.amount) n++;
  if (item.consequence) n++;
  if (item.policyNumber) n++;
  if (item.frequency) n++;
  if (item.subtype) n++;
  return n;
}

const key = `household:${householdId}:vault`;
const raw = await redis.lrange(key, 0, -1);
const items = raw.map((r, i) => {
  const parsed = typeof r === "string" ? JSON.parse(r) : r;
  return { raw: r, parsed, idx: i };
});

console.log(`\n=== Vault cleanup for ${key} ===`);
console.log(`Current item count: ${items.length}`);
console.log(`Mode: ${apply ? "APPLY (will LREM losers)" : "DRY-RUN (no writes)"}\n`);

// Walk the list, grouping duplicates. Greedy: each item is compared
// against the current kept set; on a match, decide winner by info
// density, mark the loser for removal.
const kept = [];
const removals = [];

for (const item of items) {
  let matched = null;
  const itemMs = item.parsed.renewalDate ? Date.parse(item.parsed.renewalDate) : NaN;

  for (const k of kept) {
    const kMs = k.parsed.renewalDate ? Date.parse(k.parsed.renewalDate) : NaN;
    if (isNaN(itemMs) || isNaN(kMs)) continue;
    if (Math.abs(itemMs - kMs) > THIRTY_DAYS_MS) continue;
    if (vaultDescriptionOverlap(item.parsed.description, k.parsed.description) > 0.5) {
      matched = k;
      break;
    }
  }

  if (!matched) {
    kept.push(item);
    continue;
  }

  const newDensity = infoDensity(item.parsed);
  const exDensity = infoDensity(matched.parsed);
  if (newDensity > exDensity) {
    // New is richer — the kept entry becomes the loser, replace in slot.
    removals.push({ keep: item, drop: matched, reason: `density ${newDensity} > ${exDensity}` });
    const slot = kept.indexOf(matched);
    kept[slot] = item;
  } else {
    removals.push({ keep: matched, drop: item, reason: `density ${exDensity} >= ${newDensity}` });
  }
}

if (removals.length === 0) {
  console.log("No duplicates found. Vault is clean.");
  process.exit(0);
}

console.log(`Found ${removals.length} duplicate pair(s):\n`);
for (const r of removals) {
  console.log(`  KEEP: "${r.keep.parsed.description}" (id=${r.keep.parsed.id}, ${r.reason})`);
  console.log(`  DROP: "${r.drop.parsed.description}" (id=${r.drop.parsed.id})`);
  console.log("");
}

if (!apply) {
  console.log(`Final vault size after cleanup would be: ${kept.length}`);
  console.log(`\nDry-run complete. Re-run with --apply to remove ${removals.length} item(s).`);
  process.exit(0);
}

console.log(`Applying — running LREM for ${removals.length} loser(s)...`);
let removed = 0;
for (const r of removals) {
  const result = await redis.lrem(key, 1, r.drop.raw);
  if (result > 0) {
    removed++;
    console.log(`  ✓ removed id=${r.drop.parsed.id}`);
  } else {
    console.log(`  ! LREM returned 0 for id=${r.drop.parsed.id} (value may have shifted)`);
  }
}

const finalCount = await redis.llen(key);
console.log(`\nDone. Removed ${removed}/${removals.length}. Vault now has ${finalCount} items.`);
