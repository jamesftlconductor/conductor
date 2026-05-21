import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const BASE_URL = "https://conductor-ivory.vercel.app";

// Brief fetch (internal HTTP) + first-sentence extraction together can take
// ~5-10s per household. 30s budget keeps us comfortable for multi-household
// fan-out even when /api/brief is slow.
export const config = { maxDuration: 30 };

async function listHouseholds() {
  // Mirrors sync.js: derive membership from user:*:household keys, since
  // household:{id}:members is not maintained anywhere in the codebase.
  const keys = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, { match: "user:*:household", count: 100 });
    cursor = next;
    if (batch?.length) keys.push(...batch);
  } while (cursor !== "0" && cursor !== 0);

  const map = new Map();
  for (const key of keys) {
    const userId = key.slice("user:".length, -":household".length);
    const hid = (await redis.get(key)) || userId;
    if (!map.has(hid)) map.set(hid, []);
    map.get(hid).push(userId);
  }
  return map;
}

// Pull the actual brief prose so the push body matches exactly what the
// user sees when they open the app. /api/brief and /api/clearance both
// resolve household from userId and return { brief: string, ... } — any
// member's userId in a household yields the same household-level brief.
async function fetchBriefText(userId, type) {
  const path =
    type === "takeoff" ? "/api/brief"
    : type === "midday" ? "/api/midday"
    : "/api/clearance";
  const url = `${BASE_URL}${path}?userId=${encodeURIComponent(userId)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`brief fetch ${res.status}`);
  const data = await res.json();
  // /api/midday returns { midday, ... } not { brief, ... }; normalize.
  const text = type === "midday" ? data?.midday : data?.brief;
  return typeof text === "string" ? text : "";
}

// First sentence of the brief, clipped to 100 chars. Split on ". " is the
// simplest reliable boundary — abbreviations don't typically end with
// ". " (they're followed by another word with no space). When the brief
// is a single sentence with no ". " boundary, return it whole. We only
// append a terminal period when one isn't already there, so a single-
// sentence brief doesn't end up with "Hello, James..".
function firstSentence(text, max = 100) {
  if (!text) return "";
  const idx = text.indexOf(". ");
  let first = idx === -1 ? text : text.slice(0, idx + 1);
  first = first.trim();
  if (!/[.!?]$/.test(first)) first += ".";
  if (first.length > max) {
    first = first.slice(0, max - 3).trimEnd() + "...";
  }
  return first;
}

async function sendExpoPush(token, title, body, extras = {}) {
  // extras may carry { categoryId, data }. categoryId routes to an
  // iOS notification category whose action buttons (REST / HOLD /
  // TRACK) the mobile app registers at launch; data is the payload
  // the response listener uses to PATCH the signal.
  const payload = { to: token, title, body, sound: "default" };
  if (extras.categoryId) payload.categoryId = extras.categoryId;
  if (extras.data && typeof extras.data === "object") payload.data = extras.data;
  const response = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Accept-Encoding": "gzip, deflate",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  // Expo always 200s on a well-formed request; per-message success lives in
  // data.data.status — "ok" or "error" (with details.error like DeviceNotRegistered).
  const ticket = data?.data;
  const delivered = response.ok && ticket?.status === "ok";
  return { ok: delivered, status: response.status, data };
}

export default async function handler(req, res) {
  const type = req.query?.type || req.body?.type;
  const householdIdInput = req.query?.householdId || req.body?.householdId;

  // Tracking notifications skip the brief-fetch path entirely —
  // caller supplies the exact title/body to push to every member of
  // a single household. Used by the /api/track cron when a package
  // or flight status transition is worth surfacing.
  if (type === "tracking") {
    const title = req.body?.title;
    const body = req.body?.body;
    const signalId = req.body?.signalId ?? null;
    const trackingKind = req.body?.kind || null; // "out-for-delivery" | "delivered" | "delayed" | "flight-delayed"
    if (!householdIdInput || !title || !body) {
      return res.status(400).json({ error: "tracking notify requires householdId, title, body" });
    }
    const all = await listHouseholds();
    const members = all.get(householdIdInput) || [];
    let sent = 0;
    const results = [];
    for (const userId of members) {
      const token = await redis.get(`user:${userId}:expoPushToken`);
      if (!(typeof token === "string" && token.length)) continue;
      // Out-for-delivery is the one tracking transition where the
      // user can usefully act from the lock-screen ("Got it ✓"
      // resolves the package on arrival). Other tracking transitions
      // get the same payload data but the PACKAGE_TRACKING category
      // is harmless if the action isn't relevant — iOS just shows
      // the buttons.
      const r = await sendExpoPush(token, title, body, {
        categoryId: "PACKAGE_TRACKING",
        data: {
          type: "tracking",
          kind: trackingKind,
          signalId,
          userId,
          householdId: householdIdInput,
        },
      });
      results.push({ userId, ok: r.ok });
      if (r.ok) sent++;
    }
    return res.status(200).json({ ok: true, type: "tracking", sent, results });
  }

  if (type !== "takeoff" && type !== "clearance" && type !== "midday") {
    return res.status(400).json({ error: "type must be 'takeoff', 'midday', 'clearance', or 'tracking'" });
  }

  const title =
    type === "takeoff" ? "Takeoff"
    : type === "midday" ? "Midday"
    : "Clearance";
  const fallback =
    type === "takeoff" ? "Your Takeoff brief is ready."
    : type === "midday" ? "Your midday check-in is ready."
    : "Your Clearance brief is ready.";

  try {
    const allHouseholds = await listHouseholds();
    let targets;
    if (householdIdInput) {
      const members = allHouseholds.get(householdIdInput) || [];
      targets = new Map([[householdIdInput, members]]);
    } else {
      targets = allHouseholds;
    }

    const results = [];
    let sent = 0;

    // Lazy-load the timezone helper so this file imports cleanly
    // even if location.js is offline.
    let getHouseholdLocalHour = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      ({ getHouseholdLocalHour } = await import("./location.js"));
    } catch { /* skip — gate becomes a no-op */ }

    for (const [hid, members] of targets) {
      // Timezone gate — only fire takeoff/clearance/midday if the
      // current local hour for this household is within the expected
      // window. Cron fires at fixed UTC times, but a California
      // household shouldn't receive their 7am brief at 4am Pacific.
      // The window is ±1 hour around the canonical hour to absorb
      // cron drift.
      // Coarse household-level window — keeps a Pacific household
      // from getting their 7am push at 4am Pacific even when no
      // per-user preference is set. The window is wider than any
      // individual takeoffHour so per-user precision still falls
      // within. Takeoff: 5-11am (covers 5am-10am + 1h weekend delay).
      // Clearance: 7-10pm. Overwatch fires from the Clearance cron
      // when localHour is at/after the household's earliest overwatchHour.
      let cachedLocalHour = null;
      if (getHouseholdLocalHour && !householdIdInput) {
        try {
          const localHour = await getHouseholdLocalHour(hid);
          cachedLocalHour = localHour;
          const okWindow =
            type === "takeoff" ? localHour >= 5 && localHour <= 11
            : type === "midday" ? localHour >= 12 && localHour <= 14
            : type === "clearance" ? localHour >= 19 && localHour <= 23
            : true;
          if (!okWindow) {
            results.push({ household: hid, skipped: "outside local time window", localHour });
            continue;
          }
        } catch { /* fall through */ }
      }

      // Saturday=6, Sunday=0 in JS. We compute this once for the
      // household using its local timezone (approximated by passing
      // the household's local hour through Date below — exact tz
      // requires the location helper). Worst case the weekend delay
      // misfires by an hour around midnight which is acceptable.
      const isWeekend = (() => {
        try {
          const day = new Date().getDay();
          return day === 0 || day === 6;
        } catch { return false; }
      })();

      const tokensByUser = [];
      for (const userId of members) {
        const token = await redis.get(`user:${userId}:expoPushToken`);
        if (!(typeof token === "string" && token.length)) continue;

        // Load per-user preferences once per member-iteration. We
        // reuse the same fetch for the per-user takeoffHour /
        // clearanceHour / overwatchHour gate and the existing midday
        // opt-in check.
        const prefsRaw = await redis.get(`user:${userId}:preferences`);
        let prefs = null;
        try { prefs = typeof prefsRaw === "string" ? JSON.parse(prefsRaw) : prefsRaw; }
        catch { prefs = null; }

        if (type === "midday") {
          // Midday is opt-in: skip users who haven't toggled
          // middayEnabled in Settings.
          if (!prefs || prefs.middayEnabled !== true) continue;
        }

        // Per-user hour gate — only fires when the household's local
        // hour matches this user's configured takeoff/clearance hour.
        // Falls through silently when prefs or cachedLocalHour are
        // missing so existing households without configured times
        // still receive on the coarse-window default.
        if (cachedLocalHour != null && prefs) {
          const takeoffStr = typeof prefs.takeoffTime === "string" ? prefs.takeoffTime : "07:00";
          const clearanceStr = typeof prefs.clearanceTime === "string" ? prefs.clearanceTime : "21:00";
          const takeoffHour = parseInt(takeoffStr.split(":")[0] || "7", 10);
          const clearanceHour = parseInt(clearanceStr.split(":")[0] || "21", 10);
          const weekendDelay = prefs.weekendTakeoffDelay === true;
          const effectiveTakeoffHour = (isWeekend && weekendDelay)
            ? takeoffHour + 1
            : takeoffHour;

          if (type === "takeoff" && cachedLocalHour !== effectiveTakeoffHour) continue;
          if (type === "clearance" && cachedLocalHour !== clearanceHour) continue;
        }

        tokensByUser.push({ userId, token });
      }

      if (tokensByUser.length === 0) {
        results.push({ household: hid, skipped: "no tokens", members: members.length });
        continue;
      }

      // Shared-body override: first-run takeoff uses hardcoded copy for
      // every user in the household — there's no brief yet on day one to
      // lift a first sentence from. Don't flip firstRun here; brief.js
      // owns that transition so the brief and push stay in sync when
      // the user opens the app.
      let sharedBody = null;
      if (type === "takeoff") {
        const firstRunFlag = await redis.get(`household:${hid}:firstRun`);
        const isFirstRun = firstRunFlag === "true" || firstRunFlag === true;
        if (isFirstRun) {
          sharedBody = "Your first Takeoff is ready. Conductor has been reading.";
        }
      }

      // Sunday Clearance — symphony preview body. Replaces the
      // first-sentence-of-brief approach with a count of instruments
      // earned this week, because the symphony is the moment of
      // Sunday and people open the app to hear it.
      if (type === "clearance") {
        try {
          const weekday = new Date().toLocaleDateString("en-US", {
            timeZone: "America/New_York",
            weekday: "short",
          });
          if (weekday === "Sun") {
            const { mondayAnchorISO, loadWeeklyAchievements } = await import("./signals.js");
            const weekStart = mondayAnchorISO();
            const record = await loadWeeklyAchievements(hid, weekStart);
            const n = record.instrumentsEarned || 0;
            if (n >= 7) {
              sharedBody = "A full symphony this week. The Conductor is ready for Sunday.";
            } else if (n >= 5) {
              sharedBody = `${n} of 7 instruments earned this week. Your symphony plays tonight.`;
            } else if (n >= 3) {
              sharedBody = `${n} instruments this week. A measured composition.`;
            } else if (n >= 1) {
              sharedBody = `${n} instrument${n === 1 ? "" : "s"} earned. A quieter week — the music reflects it.`;
            }
            // n === 0 falls through to the per-user brief fetch.
          }
        } catch (err) {
          console.warn("[notify] symphony preview failed:", err?.message || err);
        }
      }

      // Carry-forward suffix on Takeoff only — if anything was flagged in
      // last night's LAST CHANCE pool and is still active this morning
      // (the morning brief stamps it on the carriedForward set), nudge
      // the user. Applied per-user after each user's body is computed
      // so a long first sentence doesn't push the suffix off the 100-
      // char limit.
      let carrySuffix = "";
      if (type === "takeoff") {
        const carriedCount = await redis.scard(`household:${hid}:carriedForward`);
        if (carriedCount > 0) carrySuffix = " Something from yesterday is still open.";
      }

      // Per-user brief fetch in parallel. Each /api/brief call also
      // populates user:{userId}:currentTakeoff (or :currentClearance),
      // so when the user later opens the app, brief.js serves the
      // cached response and the push body matches the app brief
      // verbatim. firstRun households short-circuit on sharedBody.
      const bodies = await Promise.all(
        tokensByUser.map(async ({ userId }) => {
          if (sharedBody) return sharedBody;
          try {
            const briefText = await fetchBriefText(userId, type);
            return firstSentence(briefText) || fallback;
          } catch (err) {
            console.error(`Brief fetch failed for ${userId}:`, err);
            return fallback;
          }
        })
      );

      for (let i = 0; i < tokensByUser.length; i++) {
        const { userId, token } = tokensByUser[i];
        let body = bodies[i];
        if (carrySuffix) {
          // Reserve room for the suffix; total stays ≤100 chars. If the
          // base body alone barely fits, trim it before appending so
          // the suffix isn't itself truncated mid-sentence.
          const budget = 100 - carrySuffix.length;
          if (body.length > budget) {
            body = body.slice(0, Math.max(0, budget - 3)).trimEnd() + "...";
          }
          body = body + carrySuffix;
        }
        const push = await sendExpoPush(token, title, body);
        if (push.ok) {
          await redis.set(`user:${userId}:lastNotification`, Date.now());
          sent++;
        }
        results.push({
          household: hid,
          userId,
          ok: push.ok,
          status: push.status,
          body,
          expo: push.data,
        });
      }
    }

    return res.status(200).json({ type, sent, householdsTargeted: targets.size, results });
  } catch (error) {
    console.error("Notify error:", error);
    return res.status(500).json({ error: "Notify failed", message: error.message });
  }
}
