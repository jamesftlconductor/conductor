// Inspect what's currently in the vault key. Diagnostic only.
// Usage: node scripts/inspect-vault-store.mjs <householdId>

import { readFileSync } from "fs";
import { Redis } from "@upstash/redis";

const envFile = readFileSync(".env.production.local", "utf-8");
for (const line of envFile.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const householdId = process.argv[2] || "RangerOaks925";
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const raw = await redis.lrange(`household:${householdId}:vault`, 0, -1);
console.log(`household:${householdId}:vault contains ${raw.length} items\n`);
for (const r of raw) {
  const item = typeof r === "string" ? JSON.parse(r) : r;
  console.log(JSON.stringify(item, null, 2));
  console.log("---");
}
