// Quick verification: find a resolved signal in :memory and confirm
// the matching commons:providers:{sender}:{region} bucket has at least
// one entry. Pulls from household RangerOaks925.
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

function normalizeProvider(name) {
  if (!name) return "";
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b(inc|llc|corp|co|ltd|company)\b\.?/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

const memRaw = await redis.lrange(`household:${householdId}:memory`, 0, 49);
const resolved = memRaw
  .map((r) => { try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; } })
  .filter((e) => e && e.action === "resolved" && e.sender);

console.log(`Found ${resolved.length} resolved entries with senders in memory log.`);

const locRaw = await redis.get(`household:${householdId}:location`);
const loc = (() => { try { return typeof locRaw === "string" ? JSON.parse(locRaw) : locRaw; } catch { return null; } })();
const region = loc?.marketRegion || "generic";
console.log(`Region: ${region}`);

const senders = [...new Set(resolved.map((e) => e.sender))].slice(0, 8);
console.log(`\nProbing commons buckets for top ${senders.length} resolved senders:\n`);
for (const sender of senders) {
  const provider = normalizeProvider(sender);
  const key = `commons:providers:${provider}:${region}`;
  const len = await redis.llen(key);
  console.log(`  ${key.padEnd(70)}  len=${len}`);
}

// Cross-region probe — many resolved signals were processed before the
// location was set, so they'd land in :generic. Show that bucket too.
console.log(`\nGeneric-region buckets for the same senders:\n`);
for (const sender of senders) {
  const provider = normalizeProvider(sender);
  const key = `commons:providers:${provider}:generic`;
  const len = await redis.llen(key);
  if (len > 0) console.log(`  ${key.padEnd(70)}  len=${len}`);
}
