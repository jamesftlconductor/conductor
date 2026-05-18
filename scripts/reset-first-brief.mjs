// Delete household:{id}:firstBriefSent so the next /api/brief
// generation prepends the welcome line again. Also clears the
// per-user currentTakeoff cache so the brief regenerates instead
// of returning a cached response.
//
// Usage: node scripts/reset-first-brief.mjs <userId>

import { readFileSync } from "fs";
import { Redis } from "@upstash/redis";

const envFile = readFileSync(".env.local", "utf-8");
for (const line of envFile.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const userId = process.argv[2];
if (!userId) {
  console.error("usage: node scripts/reset-first-brief.mjs <userId>");
  process.exit(1);
}

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const householdId = (await redis.get(`user:${userId}:household`)) || userId;
console.log(`Resolved household: ${householdId}`);

const firstKey = `household:${householdId}:firstBriefSent`;
const cacheKey = `user:${userId}:currentTakeoff`;

const a = await redis.del(firstKey);
const b = await redis.del(cacheKey);
console.log(`Deleted ${firstKey}: ${a}`);
console.log(`Deleted ${cacheKey}: ${b}`);
