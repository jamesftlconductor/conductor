// Delete the cached user:{id}:currentTakeoff key so the next /api/brief
// call forces a fresh synthesis + generation run. Useful for verifying
// prompt-rule changes without waiting the 6h TTL.
//
// Usage: node scripts/bust-takeoff-cache.mjs <userId>

import { readFileSync } from "fs";
import { Redis } from "@upstash/redis";

const envFile = readFileSync(".env.local", "utf-8");
for (const line of envFile.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const userId = process.argv[2];
if (!userId) {
  console.error("usage: node scripts/bust-takeoff-cache.mjs <userId>");
  process.exit(1);
}

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const key = `user:${userId}:currentTakeoff`;
const removed = await redis.del(key);
console.log(`Deleted ${key}: ${removed}`);
