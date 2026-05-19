// Seeds three subscription vault items for the Spend card test.
// Tagged with __spendTestSeed so cleanup is precise if needed.
// Run once; subsequent runs are idempotent (no duplicates).
import { readFileSync } from "fs";
import { Redis } from "@upstash/redis";

const envFile = readFileSync(".env.local", "utf-8");
for (const line of envFile.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const householdId = "RangerOaks925";
const userId = "james_totalhome_gmail_com";
const vaultKey = `household:${householdId}:vault`;

const today = new Date();
function isoPlusDays(days) {
  const d = new Date(today.getTime() + days * 86400000);
  return d.toISOString().slice(0, 10);
}

const seeds = [
  {
    description: "Spotify Premium",
    provider: "Spotify",
    amount: "11.99",
    category: "subscriptions",
    renewalDate: isoPlusDays(14),
  },
  {
    description: "Netflix Standard",
    provider: "Netflix",
    amount: "15.49",
    category: "subscriptions",
    renewalDate: isoPlusDays(21),
  },
  {
    description: "Amazon Prime",
    provider: "Amazon",
    amount: "14.99",
    category: "subscriptions",
    renewalDate: isoPlusDays(45),
  },
];

const existingRaw = await redis.lrange(vaultKey, 0, -1);
const existing = existingRaw
  .map((r) => { try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; } })
  .filter(Boolean);

let inserted = 0;
for (const seed of seeds) {
  const already = existing.some(
    (v) =>
      v.__spendTestSeed === true &&
      v.description === seed.description &&
      v.provider === seed.provider
  );
  if (already) {
    console.log(`Skipped duplicate seed: ${seed.description}`);
    continue;
  }
  const item = {
    id: `vault_spend_seed_${Date.now()}_${inserted}`,
    __spendTestSeed: true,
    userId,
    source: "manual",
    createdAt: new Date().toISOString(),
    handled: false,
    ...seed,
  };
  await redis.lpush(vaultKey, JSON.stringify(item));
  inserted++;
  console.log(`Inserted: ${seed.description} ($${seed.amount}/mo, renews ${seed.renewalDate})`);
}

console.log(`\n${inserted} new seeds added.`);

// Now GET the Spend endpoint and show the response.
console.log(`\nQuerying /api/signals?type=spend...\n`);
const res = await fetch(
  `https://conductor-ivory.vercel.app/api/signals?type=spend&userId=${userId}`
);
const body = await res.text();
console.log(`Status ${res.status}:`);
console.log(body);
