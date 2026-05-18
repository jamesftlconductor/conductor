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

const raw = await redis.lrange("household:RangerOaks925:signals", 0, -1);
for (const r of raw) {
  const s = typeof r === "string" ? JSON.parse(r) : r;
  const desc = (s.description || "").toLowerCase();
  if (desc.includes("chime") || desc.includes("delivery window")) {
    console.log(JSON.stringify(s, null, 2));
    console.log("---");
  }
}
