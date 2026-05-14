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

const members = await redis.smembers(`household:${householdId}:members`);
console.log(`household:${householdId}:members → ${members.length} member(s)`);
for (const m of members) console.log(`  - ${m}`);
