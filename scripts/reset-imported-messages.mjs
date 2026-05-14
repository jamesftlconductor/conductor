// Clear a user's importedMessages set so the next import re-processes
// every recent Gmail match through the new confidence gate. The content
// fingerprint set is left intact, so re-parses won't create phantom
// signals — they'll burn an Anthropic call and then be deduped.
//
// Usage: node scripts/reset-imported-messages.mjs <userId>

import { readFileSync } from "fs";
import { Redis } from "@upstash/redis";

const envFile = readFileSync(".env.production.local", "utf-8");
for (const line of envFile.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const userId = process.argv[2];
if (!userId) {
  console.error("usage: node scripts/reset-imported-messages.mjs <userId>");
  process.exit(1);
}

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const householdId = (await redis.get(`user:${userId}:household`)) || userId;
const key = `household:${householdId}:importedMessages`;
const before = await redis.scard(key);
await redis.del(key);
const after = await redis.scard(key);
console.log(`reset ${key}: ${before} → ${after}`);
