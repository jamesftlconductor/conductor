// Synthetic conflict-detection probe.
//
// Adds two overlapping signals to household:RangerOaks925:signals
// (service appointment at 2pm Thursday + travel departure at 1pm
// Thursday), triggers a fresh brief, prints the brief output, then
// removes the two test signals. The brief should detect the overlap
// and surface it.
//
// Tagged with a sentinel field __conflictTest so cleanup is precise.
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
const signalsKey = `household:${householdId}:signals`;
const cacheKey = `user:${userId}:currentTakeoff`;

// Find Thursday in the upcoming week (ET).
function nextThursdayLocal() {
  const now = new Date();
  const dow = now.getDay();
  const daysUntilThu = (4 - dow + 7) % 7 || 7;
  const d = new Date(now);
  d.setDate(d.getDate() + daysUntilThu);
  d.setHours(0, 0, 0, 0);
  return d;
}

const thu = nextThursdayLocal();
const thu2pm = new Date(thu); thu2pm.setHours(14, 0, 0);
const thu1pm = new Date(thu); thu1pm.setHours(13, 0, 0);

const baseId = Date.now();
const serviceSignal = {
  id: baseId,
  __conflictTest: true,
  description: "[TEST] HVAC service appointment",
  type: "service",
  sender: "Test HVAC LLC",
  eta: thu2pm.toISOString(),
  state: "active",
  status: "Scheduled",
  source: "manual",
  lastUpdate: new Date().toLocaleString(),
};
const travelSignal = {
  id: baseId + 1,
  __conflictTest: true,
  description: "[TEST] Flight departure to Denver",
  type: "travel",
  sender: "Test Airlines",
  eta: thu1pm.toISOString(),
  state: "active",
  status: "Confirmed",
  source: "manual",
  lastUpdate: new Date().toLocaleString(),
};

console.log(`Inserting two test signals on Thursday ${thu.toDateString()}:`);
console.log(`  - travel @ 1pm: ${travelSignal.description}`);
console.log(`  - service @ 2pm: ${serviceSignal.description}`);

await redis.lpush(signalsKey, JSON.stringify(travelSignal));
await redis.lpush(signalsKey, JSON.stringify(serviceSignal));

// Drop brief cache so the next brief call regenerates from scratch.
await redis.del(cacheKey);
await redis.del(`user:${userId}:currentClearance`);
await redis.del(`user:${userId}:currentMidday`);
console.log(`\nDropped brief cache for ${userId}.`);

// Trigger a fresh brief.
console.log(`\nRequesting fresh brief...`);
const res = await fetch(
  `https://conductor-ivory.vercel.app/api/brief?userId=${userId}&fresh=1`,
  { method: "GET" }
);
const briefBody = await res.text();
console.log(`\n--- brief response (status ${res.status}) ---`);
console.log(briefBody.slice(0, 4000));
console.log(`--- end brief ---`);

// Cleanup — remove the two test signals so they don't bleed into the
// real brief tomorrow morning.
const rawAll = await redis.lrange(signalsKey, 0, -1);
let removed = 0;
for (const raw of rawAll) {
  let parsed;
  try { parsed = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { continue; }
  if (!parsed || !parsed.__conflictTest) continue;
  await redis.lrem(signalsKey, 1, raw);
  removed++;
}
console.log(`\nCleanup: removed ${removed} test signal(s).`);

// Drop cache again so the next brief doesn't have stale conflict prose.
await redis.del(cacheKey);
await redis.del(`user:${userId}:currentClearance`);
await redis.del(`user:${userId}:currentMidday`);
console.log(`Dropped brief cache again so the test prose doesn't linger.`);
