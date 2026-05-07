# Conductor

A household intelligence layer. Reads what's already happening in a family's
inboxes, calendars, and bodies, and surfaces a calm two-sentence brief of
what actually matters today. Nothing to manage. Nothing to do. The work was
already there — Conductor just makes it visible.

This document is the canonical reference for the system. If you're
continuing the build from scratch, start here.

---

## 1. What Conductor Is

### Vision

Most household software asks the user to do more — log this, schedule
that, mark this complete. Conductor inverts the contract. The signals that
shape a family's week are already arriving in their email and calendar.
The work is in **noticing**, **prioritizing**, and **timing**. Conductor
does that, and renders the output as prose, not a list.

### Philosophy

- **Quiet by default.** A brief with nothing notable is a real outcome,
  not a failure to fill space. The product earns trust by saying less than
  the user expects.
- **Prose, not lists.** A morning brief is delivered as a 3–6 sentence
  paragraph. It reads like a thought the reader was already having.
- **Narrate, never instruct.** Briefs surface state — "your spray tan is
  at 6:30" — never imperatives. Choices stay with the household.
- **Ring before list.** The Hover screen is a circular radar where signals
  orbit the household at their natural urgency. The radar makes "what's
  near" intuitive without ever rendering a to-do.
- **Memory matters.** Every state transition is logged. The system learns
  patterns — which senders matter, which days are heavy — without
  surfacing them as features until they're confidently useful.

### North Star

A family of four wakes up, glances at one screen for ten seconds, and
walks into their day knowing exactly what's coming. No one opens the app
to manage anything. No one has homework.

---

## 2. Technical Stack

### Backend (`C:\Users\james\conductor`)

| Layer | Choice |
|---|---|
| Runtime | Node.js (ESM modules) |
| Hosting | Vercel (Pro plan) |
| Routing | Vercel serverless functions in `api/` |
| Build artefact | `vite build` for the legacy admin UI |
| Storage | Upstash Redis (REST API) |
| Queue | Upstash QStash (used for the onboarding fan-out only) |
| LLM | Anthropic API, `claude-haiku-4-5-20251001` |
| Auth | Google OAuth (Gmail + Calendar read scopes) |
| Push fan-out | Expo Push API (`https://exp.host/--/api/v2/push/send`) |
| Cron | Vercel Cron (defined in `vercel.json`) |

`@vercel/kv` is in `package.json` but is **not** used at runtime —
everything goes through `@upstash/redis` directly.

### Mobile (`C:\Users\james\conductor-mobile`)

| Layer | Choice |
|---|---|
| Framework | Expo SDK 54.0.33, React Native 0.81.5, React 19.1.0 |
| Routing | `expo-router` (file-system based) |
| State persistence | `@react-native-async-storage/async-storage` |
| Notifications | `expo-notifications` (Expo push tokens) |
| HealthKit | `@kingstinct/react-native-healthkit` v14 (Nitro Modules) |
| Gestures | `react-native-gesture-handler` |
| Animation | `react-native-reanimated` |
| SVG | `react-native-svg` |
| Icons | `lucide-react-native` |
| Build | EAS Build (preview + production profiles) |
| Custom dev client | Yes — `expo-dev-client` is required for HealthKit |

### Production URL

`https://conductor-ivory.vercel.app`

---

## 3. Data Architecture

### Redis key conventions

All keys are namespaced. There are two top-level namespaces — `user:` for
per-person data, `household:` for shared state.

#### Per-user keys

| Key | Type | Purpose |
|---|---|---|
| `user:{userId}:tokens` | string (JSON) | Google OAuth access + refresh tokens, expiry |
| `user:{userId}:profile` | string (JSON) | Email, name, picture, connectedAt |
| `user:{userId}:household` | string | Household ID this user belongs to (default = userId itself) |
| `user:{userId}:preferences` | string (JSON) | Settings-screen toggles, also diagnostic markers via shallow-merge |
| `user:{userId}:expoPushToken` | string | Most recent Expo push token from the device |
| `user:{userId}:health` | string (JSON) | Latest HealthKit snapshot (sleep / HRV / steps / etc.) |
| `user:{userId}:lastNotification` | string (timestamp) | Last successful push delivery |

`userId` is derived as `email.replace(/[@.]/g, "_")` in `callback.js` —
e.g. `james_totalhome_gmail_com`. Emails are case-sensitive in Redis but
Google normalizes to lowercase before issuing tokens, so collisions in
practice are nil.

#### Per-household keys

| Key | Type | Purpose | TTL |
|---|---|---|---|
| `household:{id}:signals` | LIST | Active signal records (LPUSH on import) | none |
| `household:{id}:calendar` | string (JSON) | Cached classified calendar events | 24h |
| `household:{id}:calendarLastSync` | string (timestamp) | Drives the per-household 23h calendar sync skip | none |
| `household:{id}:deadlines` | LIST | Document deadlines harvested during onboarding | none |
| `household:{id}:horizon` | string (JSON) | Current "horizon signal" pick + timestamp | none (7d freshness check) |
| `household:{id}:briefed` | LIST | All signal IDs ever surfaced as horizon | none |
| `household:{id}:briefedToday` | HASH | `{signalId → {status, state, ring}}` — mute lookup for repeated narration | 20h |
| `household:{id}:morningBriefed` | HASH | Same shape, written by brief.js only | 26h |
| `household:{id}:clearanceBriefed` | SET | LAST CHANCE pool IDs from the most recent clearance | 14h |
| `household:{id}:carriedForward` | SET | Signal IDs flagged carriedForward by the most recent morning brief | 48h |
| `household:{id}:briefedThisWeek` | SET | Horizon-awareness picks already used | 6d |
| `household:{id}:memory` | LIST | Lifecycle memory log; trimmed to last 500 entries | none |
| `household:{id}:importedMessages` | SET | Gmail messageIds dedup | none |
| `household:{id}:contentFingerprints` | SET | Content-hash dedup (legacy + same-content-different-message catch) | none |
| `household:{id}:members` | SET | Household members. Currently only invitees written (the inviter's membership is implied by `user:{id}:household`) | none |
| `household:{id}:health` | string (JSON) | **Deprecated.** Old household-scoped health key — `user:{id}:health` is the source of truth |
| `household:{id}:firstRun` | string ("true"/"false") | First-brief flag, drives the abbreviated firstRunRules path |

#### Invite keys

| Key | Type | Purpose | TTL |
|---|---|---|---|
| `invite:{code}` | string (JSON) | `{householdId, createdBy, createdAt, expiresAt}` | 7d |

### Signal schema

Source of truth for the shape of a signal. `import.js` writes new entries
via `LPUSH`; `signals.js` PATCH/DELETE handlers update or remove.

```jsonc
{
  "id": 1778041216918,             // Date.now()-based; numeric for imports, "deadline_xxx" for deadlines
  "messageId": "1850f...",         // Gmail messageId; used for dedup
  "description": "London Sock Company delivery",
  "carrier": "FedEx",
  "trackingNumber": "...",
  "status": "Out for Delivery",    // free-form Claude output
  "eta": "2026-05-06T...",         // ISO string or null
  "sender": "London Sock Company",
  "type": "delivery",              // ENUM (see §6)
  "userId": "james_totalhome_gmail_com",
  "source": "import",              // "import" | "onboard" | etc.
  "lastUpdate": "5/6/2026, 4:30:47 AM",  // toLocaleString — bumped on PATCH
  "state": "incoming",             // incoming | active | resolved | expired
  "expiredAt": "...",              // set when state transitions to expired
  "carriedForward": true,          // set by morning brief if survived clearance
  "carriedForwardAt": 1778093260345
}
```

### Memory entry schema

Written by `signals.js` to `household:{id}:memory` on every state
transition.

```jsonc
{
  "signalId": 1778041216918,
  "description": "London Sock Company delivery",
  "type": "delivery",
  "sender": "London Sock Company",
  "eta": "2026-05-06T...",
  "action": "resolved",            // "resolved" | "held" | "expired"
  "actionAt": "2026-05-07T02:30:40.726Z",
  "userId": "james_totalhome_gmail_com",
  "source": "import",
  "daysInSystem": 1                // age of the prior state at action time
}
```

### Health snapshot schema

Written by mobile `syncHealthIfStale` to `user:{id}:health`.

```jsonc
{
  "sleep":          { "duration": 7.2, "efficiency": 0.91 },  // hours, asleep/inBed ratio
  "hrv":            { "current": 42, "baseline7d": 50 },      // ms (SDNN)
  "restingHR":      58,                                        // bpm
  "steps":          3200,                                      // since midnight local
  "activeCalories": 320,                                       // yesterday's total
  "asOf":           1778093260345,                             // Date.now() at fetch time
  "receivedAt":     1778093262100                              // server-stamped on POST
}
```

### Household model

A household is a logical grouping. The household ID is a string — for the
dev/test household it's `RangerOaks925`, but new households created via
invite use the inviter's `userId` as the household ID by default (see
`invite/[action].js:handleGenerate`).

Membership has two sources of truth:

1. **`user:{id}:household` (per-user pointer)** — every user has one;
   default value is their own userId, overwritten when they join via
   invite. This is the canonical source.
2. **`household:{id}:members` (set)** — written only by the invite-join
   path. Incomplete (the original creator isn't in it). Used as an
   optimistic lookup; the per-user pointer is authoritative.

Code that needs to enumerate members (e.g. `sync.js`, `notify.js`,
brief/clearance ownership tagging) **scans `user:*:household`** rather
than reading the members set, since the scan reflects ground truth.

---

## 4. API Endpoints

15 serverless functions. Listed alphabetically.

### `GET /api/auth?inviteCode=...`

Starts the Google OAuth flow. The optional `inviteCode` rides through the
OAuth `state` parameter as JSON `{inviteCode}` so it survives the redirect
and is consumed by the callback.

### `GET /api/brief?userId=...`

The morning Takeoff brief. Returns `{ brief, segments, household, user,
isFirstRun }`. Internally:

1. Pulls signals, calendar, health, deadlines, briefedToday, briefedThisWeek,
   clearanceBriefed, carriedForward, household member name map.
2. Marks survivors of last night's clearance as `carriedForward`.
3. Filters non-urgent pools through the briefedToday mute (skip narration
   if status, state, and ring are all unchanged).
4. Picks the HORIZON SIGNAL (15–90 day deadline) and HORIZON AWARENESS
   (any outer-ring signal not seen this week).
5. Renders prompt with ownership tags ([YOURS] / [NAME'S] / [HOUSEHOLD]).
6. Tags clickable signal phrases via `tagBriefSegments` (Claude-driven).
7. Writes `briefedToday` + `morningBriefed` for the next mute pass.

### `GET /api/calendar`, exported `runCalendarSync(userId)`

Pulls the user's Google Calendar across all calendars, classifies each
event with Claude (`type` ∈ household/work/personal/travel), caches
classified events in `household:{id}:calendar` with a 24h TTL. Internal
23h skip (`household:{id}:calendarLastSync`) prevents redundant runs.

### `GET /api/callback`

Google OAuth callback. Exchanges code for tokens, stores
`user:{id}:tokens` + `user:{id}:profile`, consumes any invite (sets
`user:{id}:household`, SADDs to `household:{id}:members`, deletes
`invite:{code}`), fires onboarding via QStash (`/api/onboard`), redirects
to `/api/success`.

### `GET /api/clearance?userId=...`

The evening brief. Buckets signals into resolvedToday / expiredToday /
stillActive / carryingForward / urgent + near deadlines. Builds the
LAST CHANCE pool (morningBriefed members still active + any signal on
the Act Now ring). Writes `clearanceBriefed` SET (14h TTL) for tomorrow's
brief to consume.

### `POST /api/import`, exported `runImport(userId)`

Pulls last 30 days of Gmail messages matching a curated subject filter,
parses each via Claude into a structured signal, runs the post-parse
quality gate (bounce sender → all-Unknown → promo keywords → promo
sender), LPUSHes survivors into `household:{id}:signals`. Idempotent:
two SETs (`importedMessages` by Gmail messageId, `contentFingerprints`
by tracking-or-desc-hash) prevent duplicates across runs.

### `GET /api/invite/generate?userId=...`

Creates a 10-hex-char code, stores `invite:{code}` with 7-day expiry,
returns `{code, expiresAt, inviteUrl}`.

### `GET /api/invite/join?code=...`

Looks up the invite, validates expiry, redirects to `/api/auth?inviteCode=...`.
Single-use semantics enforced by `callback.js` deleting the invite key
after consumption.

### `GET|POST /api/notify?type=takeoff|clearance&householdId=...`

Push fan-out. GET form is for Vercel cron; POST form is for manual triggers.
Iterates households (one or all), generates a ≤100-char summary via Claude,
fans out to each member's Expo push token. Takeoff body gets
" Something from yesterday is still open." appended when `carriedForward`
is non-empty. Treats success as `data.status === "ok"` (Expo's ticket-model
truth) — not just HTTP 200.

### `POST /api/onboard`

Onboarding kickoff. Enqueues a QStash job for `/api/onboard-worker`.

### `POST /api/onboard-worker`

QStash-driven heavy lift: deep email scan, calendar pull, deadline
extraction, horizon picker. Writes to `household:{id}:deadlines`,
`household:{id}:calendar`, etc. Sets `firstRun` flag.

### `POST /api/parse`

**Alternate ingestion path.** Accepts raw email text in the body, filters
with Claude (YES/NO is-this-a-real-signal), and parses if yes. Predates
the `/api/import` Gmail-pull mechanism — used for webhook-driven
ingestion (e.g. SendGrid Inbound Parse, mail forwarders). Currently still
deployed; not the primary path.

### `GET /api/refresh?userId=...`, exported `getValidToken(userId)`

Refreshes the Google access token if it's within 5 minutes of expiry.
Used internally by `import.js` and `calendar.js`.

### `GET /api/signals?userId=...` and side-channel actions

The signals CRUD endpoint with multiple action sub-routes via `?type=`.

| Method + query | Purpose |
|---|---|
| `GET ?userId=...` | List active signals for the user's household |
| `GET ?type=memory&userId=...&limit=N` | Last N memory log entries |
| `GET ?type=patterns&userId=...` | Aggregate counts: topSenders, typeBreakdown, peakDays |
| `GET ?type=missedcues&userId=...` | Active signals where carriedForward=true OR lastUpdate >48h |
| `GET ?type=preferences&userId=...` | Read user preferences object |
| `POST ?type=preferences` | Shallow-merge preferences (also accepts expoPushToken, healthData) |
| `PATCH` `{id, state, userId}` | Move signal to incoming/active/resolved/expired; writes memory log on resolved/active |
| `DELETE` `{id, userId}` | Remove signal (rare) |

### `POST /api/sync`

Daily orchestration. Scans `user:*:household`, runs `runImport(userId)`
per member, runs `runCalendarSync(driverUserId)` once per household.
Cron-fired twice daily at 11:00 + 01:00 UTC.

### `GET /api/success`

HTML success page after OAuth completes. Branches on the optional
`householdId` query param to render either "You're connected" or
"You've joined {householdId}'s household." All query values are
HTML-escaped before render.

---

## 5. Product Language

The vocabulary that shows up in UI, prompts, and code. **Items in italics
are conceptual / not yet implemented.**

| Term | Meaning |
|---|---|
| **Takeoff** | Morning brief. Generated 6–12 sentences depending on first-run vs steady-state. |
| **Clearance** | Evening brief. Reflective close-of-day. Surfaces the LAST CHANCE pool. |
| **Hover** | The radar screen — three concentric rings with signals orbiting at their natural urgency. |
| **Ground** | The brief screen (named because it's the on-the-ground view of the day). The file is `app/(tabs)/index.tsx`. |
| **Finale** | The bottom-sheet detail view that appears when a signal is tapped on Hover. |
| **Rest** | The Finale gesture that resolves a signal (state → "resolved"). |
| **Hold** | The Finale gesture that keeps a signal active for later (state → "active"). |
| **Signals** | Any actionable item the system has noticed — packages, appointments, deadlines, reservations. |
| **Management in Motion** | The Hover screen header copy — what the radar represents. |
| **Act Now** | Inner ring label. Signals due today or overdue. 0.6s pulse. |
| **Approaching Fast** | Middle ring label. Next 7 days, after today. 1.5s pulse. |
| **On the Horizon** | Outer ring label. >7 days out, plus signals with no ETA. 2.5s pulse. |
| **Missed Cues** | Surfaces signals that have been carried forward or sat untouched >48h. Endpoint exists; UI does not yet. |
| **LAST CHANCE** | A clearance-prompt section listing signals from this morning still unresolved at evening. |
| **Carrying Forward** | Morning-brief acknowledgment that yesterday's LAST CHANCE items survived. |
| ***Compass*** | *Conceptual / not yet implemented.* Reserved name — likely a navigational summary view (which signals point where) but no code references it. |
| ***Programme*** | *Conceptual / not yet implemented.* Reserved name — possibly a multi-day planning surface, but no code references it. |

---

## 6. Signal Types

Maintained in two places that must stay in sync:

- Backend: enforced as a strict enum in the brief/clearance segment-tagging
  prompt (`api/brief.js`, `api/clearance.js`).
- Mobile: `components/signalTypes.ts` defines `TYPE_META` with emoji + color.

| Type | Emoji | Color | Meaning |
|---|---|---|---|
| `package` | 📦 | `#60a5fa` | A physical thing arriving — order shipped, in transit |
| `delivery` | 🚚 | `#7dd3fc` | Active delivery (out for delivery, attempted, etc.) |
| `food` | 🍽 | `#f59e0b` | Restaurant orders, DoorDash, Instacart food |
| `grocery` | 🛒 | `#a3e635` | Grocery delivery, Subscribe & Save |
| `service` | 🔧 | `#86efac` | Home services — plumber, HVAC, cleaning |
| `reservation` | 🗓 | `#f9a8d4` | Restaurant / hotel / venue bookings |
| `appointment` | 📅 | `#c4b5fd` | Personal appointments — salon, doctor, spa |
| `travel` | ✈️ | `#2dd4bf` | Flights, hotels, trip-related |
| `deadline` | ⚠️ | `#fbbf24` | Document/renewal deadlines (synthesized during onboarding) |
| `unknown` | 📍 | `#8a8780` | Type couldn't be classified but signal is real |
| **`urgent` (mobile fallback)** | 🚨 | `#ef4444` | Reserved as the meta for unknown-type signals **on the inner ring only**. Middle/outer rings use the calm `📍 #8a8780` neutral fallback (`NEUTRAL_META`) instead. |

The `metaForRing(s, ring)` helper in `signalTypes.ts` enforces the
inner-ring-only rule for the urgent emoji.

---

## 7. Brief Architecture

A brief is built in four layers, in order:

### Layer 1: Data fetch (parallel)

```
Promise.all([
  signals (LRANGE),
  calendar (GET, classified events),
  health (GET, per-user),
  horizon (GET, cached pick),
  deadlines (LRANGE),
  briefed (LRANGE, all-time horizon dedup),
  preferences,
  firstRun flag,
  briefedToday hash (mute state),
  briefedThisWeek set (horizon weekly cadence),
  clearanceBriefed set (last night's LAST CHANCE),
  carriedForward set,
  household name map (for ownership tagging)
])
```

### Layer 2: Bucketing

Signals fan out into named pools, each subject to its own rules:

- **URGENT** — `classifyUrgent(s)` matches; never muted, never delayed.
- **NEAR WINDOW** — `isInNearWindow(s)`, urgent removed, `briefedToday`-mute applied.
- **CHILDCARE** — calendar events classified as childcare/kids/school, next 48h.
- **HOME REQUIREMENTS** — service signals due today/tomorrow, `briefedToday`-mute applied.
- **FLAGGED CATEGORIES** — user-flagged `nearSignals` per category.
- **HORIZON SIGNAL** — one deadline 15–90 days out (cached for 7 days).
- **HORIZON AWARENESS** — one outer-ring signal (>14d) not in `briefedThisWeek`.
- **CARRIED FORWARD** — signals with `carriedForward=true` from yesterday.
- **HEALTH CONTEXT** — `user:{id}:health` snapshot, surfaced only when notable.

### Layer 3: Prompt rendering

`layeredContext` is a single multi-section template literal. Each pool is
rendered with `formatSignal` / `formatEvent`, both of which prefix every
line with the ownership tag (`[YOURS] / [NAME'S] / [HOUSEHOLD]`).

The system prompt is short and tonal:

> "You are Conductor, a household intelligence layer. You write calm,
> trusted, personal morning briefs for {userName}. Your voice is like a
> thought the reader was already having — never assistant-like, never
> listy, always prose."

The user prompt is `layeredContext + baseRules` (or `firstRunRules` on
the very first brief).

### Layer 4: Segment tagging

The generated brief is passed through `tagBriefSegments` — a second
Claude call that splits the prose into `{type:'text'}` and
`{type:'signal', signalId, signalType}` segments. The mobile app uses
the segments to render colored, tappable underlines on phrases that
refer to specific signals.

After segments return, the IDs Claude actually narrated are written into
`briefedToday` (20h TTL, mute) and `morningBriefed` (26h TTL, ledger).

### Brief rules (the values that shape voice)

The full rule list lives in `baseRules` inside `api/brief.js`. The
spirit:

- 5–6 sentences max, prose only.
- Lead with urgent if present.
- Health context: silent unless sleep <6h or HRV ≥15% below 7d baseline.
  Never quote numbers — only contextual observations.
- A quiet brief is a gift; end with confidence, not apology.
- Dates are lifted verbatim from server-resolved friendly strings — Claude
  never computes day-of-week or date arithmetic.

---

## 8. Signal Lifecycle

### States

```
   [import / onboard]
          │
          ▼
      incoming ────► active ────► resolved
          │                          ▲
          └──────► expired           │
                  (auto, 24h         │
                   past ETA)         │
                                     │
        (PATCH from Hover Finale ────┘
         Rest = resolved
         Hold = active)
```

| State | Source of transition | Memory log? |
|---|---|---|
| `incoming` | Default on import; never explicit | No |
| `active` | PATCH from Finale Hold | Yes — `action: "held"` |
| `resolved` | PATCH from Finale Rest | Yes — `action: "resolved"` |
| `expired` | Auto-transition during `loadSignals` when ETA + 24h grace passes | Yes — `action: "expired"` |

### Carry-forward + Missed Cues

The full daily loop:

```
Morning brief                         Evening clearance                 Next morning
─────────────                         ────────────────                  ────────────
narrate signals                       read morningBriefed               read clearanceBriefed
write morningBriefed (26h)            ∪ Act-Now-ring signals            mark survivors carriedForward=true
write briefedToday (20h)              = LAST CHANCE pool                add to carriedForward set (48h)
                                      narrate as one calm sentence      brief CARRIED FORWARD section
                                      write clearanceBriefed (14h)      Takeoff push appends
                                                                        " Something from yesterday is still open."
                                                                        if carriedForward non-empty
```

`/api/signals?type=missedcues` exposes the union of:
- Signals with `carriedForward === true`
- Signals where `lastUpdate` is >48h old

Sorted oldest-first. Feeds the future Missed Cues screen.

---

## 9. Household Model

### The dev/test household

`RangerOaks925` is the household ID for development and ongoing testing.
Two members:

- `james_totalhome_gmail_com` (creator)
- `sarahmae_rein_gmail_com` (member)

The creator's membership is implicit via `user:{id}:household`. Sarah's
membership exists in both `user:sarahmae_rein_gmail_com:household` and
(when she joined via invite) `household:RangerOaks925:members`.

### Default household for new users

When `callback.js` writes `user:{userId}:tokens`, it does **not**
explicitly set `user:{userId}:household` unless the user joined via
invite. Endpoints that read household fall back to the userId itself:

```js
const householdId = (await redis.get(`user:${userId}:household`)) || userId;
```

So a brand-new user effectively forms a one-person household until they
either send or accept an invite.

### Data ownership

- **Per-user data** (`user:{id}:*`) — tokens, profile, push token,
  health, preferences. Never shared.
- **Per-household data** (`household:{id}:*`) — signals, calendar,
  memory, brief state. Shared among all members of the household.
- **Signals carry `userId`** — used for ownership tagging in briefs
  (`[YOURS]` vs `[SARAH'S]` vs `[HOUSEHOLD]`). The signal lives in the
  shared household pool but is attributed to the specific member who
  imported it.

---

## 10. Mobile App Screens

### `app/(tabs)/index.tsx` — Ground (Takeoff/Clearance brief)

- The default tab. Renders the brief as flowing prose.
- Brief endpoint chosen by hour-of-day (`<21` → `/api/brief`, else
  `/api/clearance`).
- Phrases that refer to specific signals are rendered as colored,
  tappable inline underlines (driven by the `segments` array). Tap →
  navigate to Hover with the signal pre-selected.
- On mount, runs three async tasks: `checkConnection()` (verify
  backend), `registerForPushNotifications()` (Expo token), and
  `syncHealthIfStale()` (HealthKit snapshot, once per local day).
- Swipe left → Hover.

### `app/(tabs)/hover.tsx` — Hover (radar)

- Three concentric rotating rings (outer 60s, middle 30s, inner 15s).
- Signal dots orbit at angles derived from ETA — inner ring uses
  hours-of-day around a 12-hour clock; middle uses day-of-week; outer
  uses signal id.
- Pulse durations are ring-determined: 0.6s / 1.5s / 2.5s.
- Tap a dot → opens Finale (bottom sheet).
- Bottom of screen: infinite legend wheel of signal types, tap to
  filter.
- Swipe right → back to Ground.

### `app/(tabs)/settings.tsx` — Settings

- Household section: ID display, "Invite a member" (opens iOS share
  sheet with a generated invite URL), connected-accounts row.
- Brief Schedule: Takeoff and Clearance times, hour-stepper modal.
- Always Included: health context toggle, childcare toggle.
- High Importance: per-category toggles (finance, travel, etc.) for
  flagged categories.
- Horizon Awareness: enabled toggle, frequency picker.

### `app/onboarding.tsx`

First-run onboarding flow. Pre-OAuth state (the Connect with Google
button is also inline in `index.tsx` for users who arrive without a
session).

### `app/modal.tsx`

Generic modal route, available across the app.

### Components

- `components/Minimap.tsx` — small overview component shown on the brief
  screen.
- `components/FinaleSheet.tsx` — the bottom sheet used on Hover for
  signal detail (Rest / Hold gestures).
- `components/HealthContext.ts` — `fetchHealthSnapshot()` + diagnostic
  markers.
- `components/signalTypes.ts` — `TYPE_META`, `LEGEND_ORDER`, `metaFor`,
  `metaForRing`, `typeKeyFor`.

---

## 11. Roadmap

### Built (verified working in production)

- Daily sync orchestration (`/api/sync`) with 23h calendar cooldown.
- Push notifications via Expo (twice-daily Takeoff/Clearance crons).
- Apple HealthKit integration (sleep, HRV w/ 7d baseline, resting HR,
  steps, active calories).
- Brief signal-type enum (10 types) + mobile color map.
- Full signal lifecycle: briefedToday mute, morningBriefed ledger,
  clearance LAST CHANCE pool, carry-forward marking, CARRIED FORWARD
  prompt section, Takeoff push suffix, missed-cues query.
- Hover ring labels: ACT NOW / APPROACHING FAST / ON THE HORIZON.
- Inner-ring-only urgent emoji (`metaForRing`).
- Household invite flow (generate code → share sheet → join via OAuth).
- Signal memory log + pattern aggregation stub.
- Import-side noise filter (bounce senders, promo regex, all-Unknown
  shells).
- Per-recipient ownership tagging in briefs ([YOURS] / [NAME'S] /
  [HOUSEHOLD]).

### In progress (committed, awaiting next EAS build)

- Health diagnostic markers (`fddf5ce`) — investigating why
  `user:{id}:health` is unset despite the sync wiring.

### Planned (named, not yet built)

- **Missed Cues UI screen** in mobile — endpoint exists; no consumer.
- **Compass** — undefined surface; reserved name.
- **Programme** — undefined surface; reserved name.
- **Multi-household onboarding polish** — invitee currently lands on a
  generic success page; could carry richer first-brief context.
- **Cron monitoring/alerting** — sync/notify cron failures are silent.

### Known issues / debt

- The per-day signal-type peak-days bucket aggregates on `actionAt`
  (when the user/system acted), not arrival time. Adding `importedAt` on
  signals would give arrival-time peaks.
- `clearance.js` and `brief.js` duplicate `classifyUrgent`,
  `isInNearWindow`, `dayOffsetFromToday`, `withinNextDays`, `computeRing`,
  `buildHouseholdNameMap`, `ownershipTag`. The duplication is deliberate
  to keep file routing simple, but ring-shape consistency depends on
  manual sync. Worth lifting into `api/_shared.js` next time the area is
  touched.
- Push registration removed the cache-gated dedup (always POSTs on every
  app launch) for safety; cost is one round trip per cold start.

---

## 12. Costs

**No measured monthly burn data is available at the time of writing.**
This section is a framework for what to track once costs are pulled.

### What to track

| Provider | Plan | Cost driver | Per-household impact |
|---|---|---|---|
| Vercel | Pro | Function execution time, bandwidth | Briefs are short-running; sync is the heaviest call (~30s per run × 2/day) |
| Upstash Redis | Free → Pay-as-you-go | Commands per month | Each brief reads ~10 keys; each sync ~50–100 commands |
| Anthropic | Claude Haiku 4.5 | Input + output tokens | Per brief: ~2 calls (generation + segment tagging), ~3K input tokens, ~600 output. Per import: 1 call per email parsed. |
| Apple Developer | $99/year fixed | — | Required for iOS push + HealthKit |
| Expo Push | Free | — | No cost; rate-limited only |
| Expo EAS Build | Free tier or paid | Build minutes | ~20 min per iOS preview build |

### Pricing model (not yet defined)

The user-facing pricing model has not been set. Candidate framings worth
exploring once cost data exists: per-household subscription, usage-based
(N briefs/month), bundle with a trusted-services partner.

---

## 13. Environment Variables

All required server-side. No values shown — pull from Vercel Project
Settings or `.env.local` (gitignored, ephemerally created via
`vercel env pull`).

| Variable | Used in |
|---|---|
| `UPSTASH_REDIS_REST_URL` | Every endpoint that touches Redis |
| `UPSTASH_REDIS_REST_TOKEN` | Every endpoint that touches Redis |
| `ANTHROPIC_API_KEY` | `brief.js`, `clearance.js`, `import.js`, `calendar.js`, `notify.js`, `parse.js`, `onboard-worker.js` |
| `GOOGLE_CLIENT_ID` | `auth.js`, `callback.js`, `refresh.js` |
| `GOOGLE_CLIENT_SECRET` | `callback.js`, `refresh.js` |
| `QSTASH_TOKEN` | `onboard.js` (enqueues onboard-worker) |
| `QSTASH_CURRENT_SIGNING_KEY` | `onboard-worker.js` (verifies QStash signature) |
| `QSTASH_NEXT_SIGNING_KEY` | `onboard-worker.js` (rotation) |

Mobile-side, `app.json` carries the EAS `projectId` under
`expo.extra.eas.projectId`. No other secrets are baked into the mobile
build.

---

## 14. Build Commands

### Backend (from `C:\Users\james\conductor`)

| Task | Command |
|---|---|
| Run dev server (admin UI only) | `npm run dev` |
| Build admin UI | `npm run build` |
| Lint | `npm run lint` |
| Pull production env | `vercel env pull .env.local --yes` |
| Deploy to production | `vercel --prod --yes` |
| Tail recent logs | `vercel logs --since 1h --no-follow --no-branch` |
| Filter logs by request | `vercel logs --query "POST /api/signals" --no-follow --no-branch` |

The serverless functions in `api/` are not part of the Vite build — they
deploy as-is.

### Mobile (from `C:\Users\james\conductor-mobile`)

| Task | Command |
|---|---|
| Start dev client | `npm run start` (i.e. `expo start`) |
| Lint | `npm run lint` |
| iOS preview build (TestFlight-equivalent internal IPA) | `eas build --platform ios --profile preview` |
| iOS development build (dev client, hot reload) | `eas build --platform ios --profile development` |
| iOS production build (App Store submission) | `eas build --platform ios --profile production` |
| List recent builds | `eas build:list --platform ios --limit 5` |
| Inspect credentials state | `eas credentials --platform ios` |
| Confirm Expo login | `eas whoami` |

The `preview` profile is recommended for day-to-day testing — it builds
a standalone IPA with internal distribution, includes the latest commit,
and doesn't require TestFlight.

### Cron schedule (from `vercel.json`)

```
0 11 * * *   /api/sync                         # 6 AM ET (EST) — pre-Takeoff
0 1  * * *   /api/sync                         # 8 PM ET (EST) — pre-Clearance
0 12 * * *   /api/notify?type=takeoff          # 7 AM ET (EST)
0 2  * * *   /api/notify?type=clearance        # 9 PM ET (EST)
```

All four crons run in fixed UTC. During EDT (mid-March through early
November), they fire one hour later in local time.

---

*Last updated against commit `b86dc9f` on backend and `fddf5ce` on
mobile.*
