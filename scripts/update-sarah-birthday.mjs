// Set Sarah's birthday to 05-22 in the household:RangerOaks925:crew array.
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
const key = "household:RangerOaks925:crew";
const raw = await redis.get(key);
const crew = typeof raw === "string" ? JSON.parse(raw) : raw;
if (!Array.isArray(crew)) { console.log("No crew array."); process.exit(1); }
const idx = crew.findIndex((m) => m && (m.name || "").toLowerCase().includes("sarah"));
if (idx < 0) { console.log("No Sarah found."); process.exit(1); }
const before = JSON.stringify(crew[idx]);
crew[idx].birthday = "05-22";
await redis.set(key, JSON.stringify(crew));
console.log("Before:", before);
console.log("After:", JSON.stringify(crew[idx]));
