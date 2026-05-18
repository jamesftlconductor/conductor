// Inspect Sarah's crew record + birthday field.
// Usage: node scripts/inspect-sarah-birthday.mjs
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
const raw = await redis.get("household:RangerOaks925:crew");
const crew = typeof raw === "string" ? JSON.parse(raw) : raw;
if (!Array.isArray(crew)) {
  console.log("No crew array. Raw:", raw);
  process.exit(0);
}
console.log(`Crew has ${crew.length} members.`);
const sarah = crew.find((m) => m && (m.name || "").toLowerCase().includes("sarah"));
if (!sarah) {
  console.log("No member with 'sarah' in name. All members:");
  crew.forEach((m) => console.log("  -", m?.name, `(${m?.memberType})`));
  process.exit(0);
}
console.log("\nSarah's record:");
console.log(JSON.stringify(sarah, null, 2));
