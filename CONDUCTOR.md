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
| Queue | Upstash QStash (used for the onboarding fan-out) |
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
| OTA updates | `expo-updates` ^29.0.17 (EAS Update, `preview` channel) |
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
| `user:{userId}:profile` | string (JSON) | Email, name, picture, connectedAt, **`birthday` (MM-DD)**, **`anniversary` (MM-DD)** |
| `user:{userId}:household` | string | Household ID this user belongs to (default = userId itself) |
| `user:{userId}:preferences` | string (JSON) | Settings-screen toggles. Notable fields: `workCalendarName` (free-text calendar label), `flaggedCategories`, `horizonEnabled`, `horizonFrequency`, `healthContextEnabled` |
| `user:{userId}:expoPushToken` | string | Most recent Expo push token from the device |
| `user:{userId}:health` | string (JSON) | Latest HealthKit snapshot (sleep / HRV / steps / etc.) |
| `user:{userId}:calendar` | string (JSON) | Per-user classified calendar events (merged at read time via `api/calendar-loader.js`) |
| `user:{userId}:currentTakeoff` | string (JSON) | Cached takeoff brief response; ensures push body matches what the user sees in-app |
| `user:{userId}:currentClearance` | string (JSON) | Same, for clearance |
| `user:{userId}:lastNotification` | string (timestamp) | Last successful push delivery |

`userId` is derived as `email.replace(/[@.]/g, "_")` in `callback.js` —
e.g. `james_totalhome_gmail_com`.

#### Per-household keys

| Key | Type | Purpose | TTL |
|---|---|---|---|
| `household:{id}:signals` | LIST | Active signal records (LPUSH on import) | none |
| `household:{id}:calendar` | string (JSON) | **Legacy** single-driver classified events; per-user keys are now primary | 24h |
| `household:{id}:calendarLastSync` | string (timestamp) | Drives the per-household 23h calendar sync skip | none |
| `household:{id}:deadlines` | LIST | Document deadlines harvested during onboarding | none |
| `household:{id}:vault` | LIST | Recurring obligations (subscriptions, registrations, insurance, leases, warranties, medical, memberships) — populated by Job 1 email-sweep + Job 3 five-pass vault sweep | none |
| `household:{id}:crew` | string (JSON) | Children + pets + household-member records (each `{memberType, userId?, firstName, fullName, picture?, birthday?, anniversary?, …}`) | none |
| `household:{id}:horizon` | string (JSON) | Current horizon signal pick + timestamp | none (7d freshness check) |
| `household:{id}:briefed` | LIST | All signal IDs ever surfaced as horizon | none |
| `household:{id}:briefedToday` | HASH | `{signalId → {status, state, ring}}` — mute lookup for repeated narration | 20h |
| `household:{id}:morningBriefed` | HASH | Same shape, written by brief.js only | 26h |
| `household:{id}:clearanceBriefed` | SET | LAST CHANCE pool IDs from the most recent clearance | 14h |
| `household:{id}:carriedForward` | SET | Signal IDs flagged carriedForward by the most recent morning brief | 48h |
| `household:{id}:briefedThisWeek` | SET | Horizon-awareness picks already used | 6d |
| `household:{id}:memory` | LIST | Lifecycle memory log; trimmed to last 500 entries | none |
| `household:{id}:importedMessages` | SET | Gmail messageIds dedup | none |
| `household:{id}:contentFingerprints` | SET | Content-hash dedup | none |
| `household:{id}:members` | SET | Household members. Currently only invitees written | none |
| `household:{id}:firstRun` | string ("true"/"false") | First-brief flag, drives the abbreviated firstRunRules path | none |
| `household:{id}:feedback` | LIST | Per-brief thumbs feedback entries (trimmed to last 200) | none |
| `household:{id}:feedbackStats` | HASH | Four counters: `takeoff_up`, `takeoff_down`, `clearance_up`, `clearance_down` — read by brief.js / clearance.js to tune voice | none |
| `household:{id}:onboardStatus` | HASH | Per-job onboarding status (state, startedAt, finishedAt, summary, `job:<emails|calendar|vault|crew|horizon>`) | none |

#### Suggestion + invite keys

| Key | Type | Purpose | TTL |
|---|---|---|---|
| `signal:{signalId}:suggestion` | string (JSON) | One-sentence next-step suggestion produced by `/api/suggest`. Stable text on tap-twice + Hover prefetch | 12h |
| `invite:{code}` | string (JSON) | `{householdId, createdBy, createdAt, expiresAt}` | 7d |

### Signal schema

```jsonc
{
  "id": 1778041216918,
  "messageId": "1850f...",
  "description": "London Sock Company delivery",
  "carrier": "FedEx",
  "trackingNumber": "...",
  "status": "Out for Delivery",
  "eta": "2026-05-06T...",
  "sender": "London Sock Company",
  "type": "delivery",
  "userId": "james_totalhome_gmail_com",
  "source": "import",
  "lastUpdate": "5/6/2026, 4:30:47 AM",
  "state": "incoming",
  "expiredAt": "...",
  "carriedForward": true,
  "carriedForwardAt": 1778093260345,
  "notedAt": "2026-05-15T..."   // set by Horizon "Noted" PATCH
}
```

### Crew member schema (`household:{id}:crew` entries)

```jsonc
// Household member (auto-populated on join)
{
  "memberType": "member",
  "userId": "sarahmae_rein_gmail_com",
  "firstName": "Sarah",
  "fullName": "Sarah Rein",
  "email": "sarahmae.rein@gmail.com",
  "picture": "https://lh3.googleusercontent.com/...",
  "joinedAt": "2026-04-09T...",
  "birthday": "05-24",        // MM-DD, mirrored from user profile
  "anniversary": null
}

// Child (extracted by onboard Job 4 crew sweep)
{
  "memberType": "child",
  "name": "Mia",
  "age": 8,
  "activities": [{ "name": "Soccer", "schedule": "Tue/Thu 5pm", "location": "Lincoln Park" }],
  "school": { "name": "Roosevelt Elementary", "pickupTime": "3:15pm" },
  "events": [{ "title": "Dentist", "date": "2026-05-22" }],
  "birthday": "07-14"
}

// Pet
{ "memberType": "pet", "name": "Rocco", "species": "dog", "breed": "Goldendoodle", "birthday": "03-02" }
```

### Vault item schema (`household:{id}:vault` entries)

```jsonc
{
  "id": "vault_email_1778736607306_0",
  "description": "Health Tech Nerds membership",
  "provider": "Health Tech Nerds",
  "category": "subscription",         // insurance, registration, subscription, lease, legal, warranty, medical, financial, membership, other
  "renewalDate": "2026-05-20",        // YYYY-MM-DD
  "amount": "$50",
  "consequence": "Loses access to private community",
  "confidence": "high",               // high | medium | low
  "source": "email_sweep",            // or "five_pass" or "user_added"
  "policyNumber": null,
  "handled": false,
  "handledAt": null
}
```

### Health snapshot schema

```jsonc
{
  "sleep":          { "duration": 7.2, "efficiency": 0.91 },
  "hrv":            { "current": 42, "baseline7d": 50 },
  "restingHR":      58,
  "steps":          3200,
  "activeCalories": 320,
  "asOf":           1778093260345,
  "receivedAt":     1778093262100
}
```

### Household model

Membership has two sources of truth — `user:{id}:household` (canonical
per-user pointer) and `household:{id}:members` (set, written only on
invite-join). Code that enumerates members **scans `user:*:household`**
since the scan reflects ground truth.

`brief.js` and `clearance.js` additionally compute `isSingleMember =
members.length <= 1` and return it on the response. When true, ownership
tagging collapses to a single-person variant ("Always use 'you' and
'your'. Never refer to any other household member by name.") and every
signal is tagged `[YOURS]` regardless of stored `userId`.

---

## 4. API Endpoints

18 serverless functions. Listed alphabetically.

### `GET /api/auth?inviteCode=...`

Starts the Google OAuth flow. Optional `inviteCode` rides through the
OAuth `state` parameter so it survives the redirect.

### `GET /api/brief?userId=...`

The morning Takeoff brief. Returns:

```jsonc
{
  "brief":         "…",          // prose, 5 sentences standard / 7 in travel mode
  "segments":      [...],        // {type:'text'|'signal', signalId, signalType}
  "transparency":  "…" | null,   // 2nd Claude call: why this brief, what was omitted
  "theRead":       "…" | null,   // 3rd Claude call: collapsible overflow, 1-3 sentences
  "household":     "RangerOaks925",
  "user":          "James",
  "isFirstRun":    false,
  "isSingleMember":false
}
```

Internally: parallel data fetch → bucketing → prompt render → four
parallel Claude calls (main brief + segment tagging + transparency + The
Read). Response is cached to `user:{id}:currentTakeoff` so the
takeoff push body and the app brief stay identical.

### `GET /api/calendar`, exported `runCalendarSync(userId)`

Pulls Google Calendar, classifies each event with Claude (`type` ∈
household/work/personal/travel). **Work events are stripped to time
blocks only** via `stripToTimeBlock()` — title, description, attendees,
location, calendar name, eventType are dropped before persistence. Both
the pre-tag path (work-calendar match by name or by `workCalendarName`
preference, `outOfOffice`/`focusTime` event types) and the LLM-classified
path route work events through the stripper. Storage is content-free; the
LLM only sees the title transiently to classify.

### `api/calendar-loader.js`

Internal merger. Reads `user:{id}:calendar` for every household member,
unions and dedupes, falls back to `household:{id}:calendar` for legacy
unsynced households. Used by `brief.js` and `clearance.js`.

### `GET /api/callback`

Google OAuth callback. Exchanges code for tokens, stores
`user:{id}:tokens` + `user:{id}:profile`, consumes any invite. **On every
join/auto-create/return, idempotently appends a `memberType: "member"`
record to `household:{id}:crew`** (preserves prior Edit-modal updates).
Fires onboarding via QStash, redirects to `/api/success`.

### `GET /api/clearance?userId=...`

The evening brief. Same shape as `/api/brief` (with `transparency` +
`theRead` + `isSingleMember`). Buckets resolvedToday / expiredToday /
stillActive / carryingForward / urgent + near deadlines. Builds LAST
CHANCE from `morningBriefed` ∪ Act-Now ring. Writes `clearanceBriefed`
(14h TTL). Response cached to `user:{id}:currentClearance`.

### `POST /api/feedback`

Records thumbs feedback from the brief screen. Body:
`{userId, briefType: "takeoff"|"clearance", rating: "up"|"down", briefDate?}`.
Appends to `household:{id}:feedback` (LTRIM to 200) and HINCRBYs the
matching counter on `household:{id}:feedbackStats`. brief.js and
clearance.js read the stats on every generation to tune voice.

### `POST /api/import`, exported `runImport(userId)`

Pulls last 30 days of Gmail, parses each via Claude, runs the post-parse
quality gate, LPUSHes survivors. Two SETs (`importedMessages`,
`contentFingerprints`) prevent duplicates.

### `GET /api/invite/generate?userId=...` / `GET /api/invite/join?code=...`

Invite-flow endpoints. Generate creates a 10-hex-char code with 7-day
expiry. Join validates and redirects through OAuth.

### `GET|POST /api/notify?type=takeoff|clearance&householdId=...`

Push fan-out. Uses the cached `user:{id}:currentTakeoff` /
`currentClearance` for the push body (first sentence of the actual brief
that user will see in-app — no separate Claude call for body text).
Treats success as `data.status === "ok"`.

### `POST /api/onboard`

Onboarding kickoff. **Fans out 4 parallel QStash messages**: `emails`,
`calendar`, `vault`, `crew`. Each runs in its own 60s function
invocation. `horizon` chains off `vault` completion since horizon reads
`:vault`. Status lives in the `onboardStatus` Redis hash with per-job
`job:<name>` fields so concurrent HSETs don't race.

### `POST /api/onboard-worker`

QStash-driven heavy lift. Dispatches on `job` field of the QStash payload.

| Job | Output |
|---|---|
| `emails` | Deep Gmail scan → `:signals` |
| `calendar` | `runCalendarSync(userId)` → `:user:{id}:calendar` |
| `vault` | Five-pass Gmail extraction (insurance/registration/subscription/lease/warranty) → `:vault`. Pass prompts require category AND renewal-verb in subject. Full email bodies fetched + HTML-stripped. Word-overlap dedup (not substring includes). Per-pass observability logs |
| `crew` | Pass 1: extract children + pets from email signatures + auto-replies. Pass 2: **birthday + anniversary Gmail pass** keyed on subjects — Claude extracts `{memberType, name, eventType, date (MM-DD, no year), age, notes}`. Three routing paths: A) name matches household member → write `user:{id}:profile.birthday`/`.anniversary`. B) matches existing crew member → patch field. C) new name → add crew record |
| `horizon` | Pick one deadline 14–90 days out → `:horizon` |

### `POST /api/parse`

Alternate webhook ingestion path. YES/NO filter then parse.

### `GET /api/refresh?userId=...`, exported `getValidToken(userId)`

Token refresh helper.

### `GET /api/signals?userId=...` and side-channel actions

| Method + query | Purpose |
|---|---|
| `GET ?userId=...` | List active signals |
| `GET ?type=memory&userId=...&limit=N` | Last N memory log entries |
| `GET ?type=patterns&userId=...` | topSenders / typeBreakdown / peakDays / averageResolutionTime / mostActiveCategory / quietestDay / householdAge |
| `GET ?type=missedcues&userId=...` | carriedForward=true OR lastUpdate >48h, oldest-first |
| `GET ?type=preferences&userId=...` | Read prefs object |
| `POST ?type=preferences` | Shallow-merge prefs (accepts `expoPushToken`, `healthData`, `workCalendarName`) |
| `GET ?type=vault&userId=...` | Vault items not handled, sorted by renewalDate asc |
| `POST ?type=vault` action=`add\|handle\|delete` | Vault CRUD from the mobile Add modal + Handled button |
| `GET ?type=crew&userId=...` | Crew records (children + pets + household members) |
| `POST ?type=crew` | Update birthday/anniversary. Path A: `targetUserId` provided → write `user:{id}:profile` AND mirror to crew. Path B: `memberType + name` → update crew record only. MM-DD format validated |
| `PATCH` `{id, state, userId, notedAt?}` | State transitions; writes memory log |
| `DELETE` `{id, userId}` | Remove signal |

### `POST /api/suggest`

Per-signal next-action suggestion. Body:
`{userId, signalId, signalType, description, sender, status, eta}`.
Cache read on `signal:{signalId}:suggestion` (12h TTL) — short-circuits on
hit. Otherwise one Haiku call with worked-example prompt (package /
subscription / flight / appointment / registration patterns). Strips
surrounding quotes. Returns `{suggestion, cached}`. `maxDuration: 15s`.
Empty/failure paths return 502 — silent failure in the UI is intentional.

### `POST /api/sync`

Daily orchestration. Scans `user:*:household`, runs `runImport(userId)`
per member, runs `runCalendarSync` per member.

### `GET /api/success`

HTML success page after OAuth.

---

## 5. Product Language

| Term | Meaning |
|---|---|
| **Takeoff** | Morning brief |
| **Clearance** | Evening brief |
| **Hover** | The radar — three concentric rings |
| **Ground** | The brief screen (`app/(tabs)/index.tsx`) |
| **Finale** | Bottom-sheet detail view on Hover |
| **Rest** | Finale gesture → resolved |
| **Hold** | Finale gesture → active |
| **Noted** | Horizon-screen gesture → active, with `notedAt` stamp |
| **Signals** | Anything Conductor has noticed |
| **Management in Motion** | Hover header (family view) |
| **Act Now / Approaching Fast / On the Horizon** | Ring labels (0.6s / 1.5s / 2.5s pulse) |
| **Missed Cues** | Carried-forward or >48h-untouched signals |
| **LAST CHANCE** | Clearance section listing signals still unresolved at evening |
| **Carrying Forward** | Morning acknowledgment that yesterday's LAST CHANCE survived |
| **The Read** | Optional 1–3 sentence overflow context, collapsible below the brief on Ground |
| **Crew** | Children + pets + household members layer |
| **Vault** | Recurring obligations (subscriptions, registrations, insurance, etc.) |
| **The Horizon** | Full-screen view of 14–90-day deadlines |
| **Compass** | Household analytics — Pulse / Top Sources / Type Breakdown / Peak Days / Resolution Speed |
| **Overwatch** | Radar-only summary view (Hover-adjacent) |
| **Yesterday** | Modal view of recent resolutions / memory log |
| **Programme** | Brief Schedule (Settings section, renamed) |
| **Awareness** | Settings section header (formerly "Intelligence") covering work-calendar, childcare, health, flagged categories |

---

## 6. Signal Types

Maintained in two places that must stay in sync:

- Backend: enforced as a strict enum in segment-tagging.
- Mobile: `components/signalTypes.ts` defines `TYPE_META`.

| Type | Emoji | Color | Meaning |
|---|---|---|---|
| `package` | 📦 | `#60a5fa` | Physical thing arriving |
| `delivery` | 🚚 | `#7dd3fc` | Active delivery |
| `food` | 🍽 | `#f59e0b` | Restaurant / DoorDash / Instacart |
| `grocery` | 🛒 | `#a3e635` | Grocery / Subscribe & Save |
| `service` | 🔧 | `#86efac` | Home services |
| `reservation` | 🗓 | `#f9a8d4` | Restaurant / hotel / venue |
| `appointment` | 📅 | `#c4b5fd` | Salon / doctor / spa |
| `travel` | ✈️ | `#2dd4bf` | Flights / hotels / trip-related |
| `deadline` | ⚠️ | `#fbbf24` | Document / renewal deadlines |
| `unknown` | 📍 | `#8a8780` | Real signal but unclassifiable |
| `urgent` (inner-ring fallback) | 🚨 | `#ef4444` | Unknown-type **on inner ring only** (`metaForRing`) |

Horizon signals get `signalType: "deadline"` tagged when pushed to the
segmenter pool. The segmenter coerces output signalTypes to the canonical
pool type server-side and rejects cross-pool signalId borrowing (fixed
in `cd474ef`).

---

## 7. Brief Architecture

A brief is built in four layers.

### Layer 1: Parallel data fetch

Signals, calendar (per-user merge via `calendar-loader`), health, horizon,
deadlines, vault, crew, briefed, preferences, firstRun, briefedToday,
briefedThisWeek, clearanceBriefed, carriedForward, members, feedbackStats,
weather, household name map.

### Layer 2: Bucketing

- **URGENT** — `classifyUrgent(s)`; never muted.
- **NEAR WINDOW** — `isInNearWindow(s)`, urgent removed, briefedToday-mute applied.
- **CHILDCARE** — calendar events classified as childcare/kids/school, next 48h.
- **HOME REQUIREMENTS** — service signals due today/tomorrow.
- **FLAGGED CATEGORIES** — user-flagged `nearSignals` per category.
- **HORIZON SIGNAL** — one deadline 15–90 days out (cached 7 days).
- **HORIZON AWARENESS** — outer-ring signal not in `briefedThisWeek`.
- **CARRIED FORWARD** — signals with `carriedForward=true`.
- **HEALTH CONTEXT** — `user:{id}:health`, surfaced only when notable.
- **TRAVEL PREP** — any `travel` signal with ETA within 72 hours. Composes:
    - Closest imminent travel signal
    - Accommodation: reservation with ETA in [travel − 24h, travel + 7d]
    - Pre-departure deliveries: delivery/package between now and travel ETA
    - Same-day conflicts: service/appointment within 12h before to 24h after the travel ETA
    - Destination extracted via `AIRPORT_TO_CITY` map (3-letter codes) + "to / in <Capitalized City>" patterns, with stopword filter
- **HOUSEHOLD BIRTHDAYS / ANNIVERSARIES** — loops `user:*:profile` for MM-DD matches in the next 14 days; renders in the prompt with relational framing ("Sarah's birthday is in 1 week").

### Layer 3: Prompt rendering

`layeredContext` is a single multi-section template literal. Each pool
prefixes every line with an ownership tag (`[YOURS] / [NAME'S] /
[HOUSEHOLD]`). When `isSingleMember`, all tags collapse to `[YOURS]`.

System prompt is short and tonal. User prompt is `layeredContext +
baseRules`.

### Layer 4: Four parallel Claude calls

After the main generation completes, three more calls fire in parallel:

1. **Segment tagging** — splits prose into `{type:'text'}` /
   `{type:'signal', signalId, signalType}` for tappable underlines.
   Server-side validation coerces signalType back to its canonical pool
   type and rejects signalIds that didn't appear in the prompt's pool.
2. **Transparency** — 2–4 sentences on why this brief was written this
   way, what was included/omitted, what's being watched. Lift-don't-
   compute applied to authoritative ETA phrases. Renders behind a "How
   Conductor thought about this" link.
3. **The Read** — 1–3 sentences of lower-urgency overflow context.
   Returns literal `"NOTHING"` → null when there's nothing worth saying.
   Renders behind a collapsible section below the brief on Ground.

After tagging, IDs Claude actually narrated are written to `briefedToday`
(20h TTL) and `morningBriefed` (26h TTL).

### Brief rules (the values that shape voice)

Captured in `baseRules` inside `api/brief.js`. The non-obvious ones:

- **Sentence cap**: 5 standard, **7 in travel-prep mode**.
- **Lift-don't-compute** for dates and day-counts. Server emits the
  authoritative ETA as a friendly string with `(in N days)` /
  `(yesterday)` / `(already passed N days ago)` / `(in 2 weeks)` for clean
  multiples of 7. Brief must lift the parenthesized phrase as a
  contiguous substring, character-for-character, including the leading
  word `"in"`. Past-dated phrases mean stale/outstanding or omit — never
  forward-looking.
- **No relative-duration phrasing between signals** ("five days later",
  "a week away", "a week to think about that" — all banned as
  paraphrases).
- **Horizon closers** — exactly one phrase per use, no variations or
  suffixes: `"worth watching"`, `"Conductor has its eye on this"`, `"on
  the radar"`, `"watching for it"`, `"we'll flag it when it matters"`.
  Threshold raised to 14 days. No `"as it gets closer"` tail. No
  `"we're watching"` (Conductor is the subject).
- **No weather closers** — banned: `"Clear skies today"`, `"Clear skies
  ahead"`, `"Otherwise quiet weather"`, `"Nothing weather-related"`, `"The
  weather's calm"`, `"weather looks fine"`. CRITICAL-level rule.
- **No duplicate sentence about the same signal**.
- **Health context**: silent unless sleep <6h or HRV ≥15% below 7d
  baseline. Never quote numbers — only contextual observations.
- **A quiet brief is a gift; end with confidence, not apology.**

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
                  (auto)             │
                                     │
        (PATCH from Hover Finale ────┘
         Rest = resolved
         Hold = active
         Noted = active w/ notedAt)
```

### Auto-expiry rules (in `loadSignals` on every GET)

| Type | Window past ETA |
|---|---|
| Service / reservation / appointment | Immediate |
| Food / grocery | 4h |
| Package / delivery | 48h (bypassed if status === "Delivered") |
| **Any incoming, no ETA** | **7d stale** |

Every transition logs `console.log("auto-expired signal {id} type={type}
reason=eta-past-{type}-window | incoming-no-eta-stale-7d")`.

### Carry-forward + Missed Cues

Same daily loop as before. `/api/signals?type=missedcues` returns the
union of `carriedForward === true` and `lastUpdate >48h`, oldest-first.
Mobile screen at `app/(tabs)/missed-cues.tsx` consumes it; entry points
on Hover + Settings (with brass count badge when count > 0).

---

## 9. Household Model

`RangerOaks925` is the dev/test household. Two members:
`james_totalhome_gmail_com`, `sarahmae_rein_gmail_com`.

Default household for new users is their own userId. Joining via invite
sets `user:{id}:household` to the inviter's household and `SADD`s to
`household:{id}:members`. **`callback.js` also writes a
`memberType: "member"` crew record on every join/auto-create/return**,
preserving any Edit-modal updates.

---

## 10. Mobile App Screens

### Tab routes — `app/(tabs)/`

#### `index.tsx` — Ground

- Renders the brief as flowing prose. Greeting interpolates first name
  from `data.user` ("Good morning, James.").
- In-flow date appears below the brief, with a tap-to-open Yesterday link.
- **Thumbs feedback row** (28px ✓/✗ buttons) sits between brief and
  transparency link. Default 40%/40% opacity; tap sets selected → 100%,
  other → 20%. Fire-and-forget POST to `/api/feedback`. Resets every
  brief reload.
- **Transparency link** → modal showing `data.transparency`.
- **The Read** (when `data.theRead` is non-null) renders as a
  collapsed-by-default section. Tap to expand, fades in/out.
- Brief endpoint chosen by hour-of-day (`<21` → brief, else clearance).
- Minimap top-left (moved from top-right). Date cluster top-right.
- Signals with `signalId` segments render as tappable colored
  underlines.

#### `hover.tsx` — Hover

- Three concentric rings (60s / 30s / 15s rotation). Ring expansion uses
  tap-and-hold (spring tension 200, friction 14). Reposition fade 150ms.
- **Top-right view-mode toggle**: 👨‍👩‍👧 family / 👤 personal.
  Persists in `AsyncStorage['hoverViewMode']`. Personal mode filters to
  `userId === USER_ID` or unowned signals. Header text adapts —
  "Management in Motion" in family, first-name + period ("James.") in
  personal.
- **+ Add Signal** lives inside the legend wheel (one of the nav items).
  Opens `AddSignalSheet` for manual signal entry; freshly-added dot
  pulses on the radar.
- Infinite legend wheel doubles as nav: Compass, Horizon, Vault, Crew,
  Missed Cues, Settings.
- Below wheel: side-by-side "The Horizon" + "Missed Cues" links.
- On mount: **prefetches `/api/suggest` for the top 3 ETA-ascending
  signals** so FinaleSheet taps within the 12h cache window are instant.

#### `missed-cues.tsx`

- One row per missed-cue signal. Color-coded "X days unresolved" —
  muted <48h, amber past 48h, brass past 7d.
- Rest / Hold buttons optimistically remove the row.

#### `settings.tsx`

- **Household** section: ID, "Invite a member", connected-accounts,
  Crew row, Vault row (with brass count badge for items renewing
  ≤90d), Missed Cues row (with count badge).
- **Programme** (renamed from Brief Schedule): Takeoff + Clearance times.
- **Awareness** (renamed from Intelligence): health-context toggle,
  childcare toggle, **Work Calendar** TextInput
  (persists `workCalendarName` preference).
- **High Importance**: per-category toggles for flagged categories.
- **Horizon Awareness**: enabled toggle, frequency picker, "View The
  Horizon" row (gated on `horizonEnabled`).

### Full-screen routes — `app/*.tsx` (registered on root Stack, `headerShown: false`)

- `crew.tsx` — Household / Children / Pets sections. Household cards show
  avatar from Google picture, "Connected · {date}", birthday/anniversary
  display rows. Edit link → modal with MM-DD inputs that POSTs to
  `/api/signals?type=crew` with `targetUserId`. Child cards include
  activities, school, upcoming events.
- `vault.tsx` — Sectioned by display category. Per-row color-coded "X
  days" indicator (red <14, amber 14–60, brass 60–90, muted 90+),
  confidence dot (sage high / orange med / muted low), Handled button.
  Tap-to-expand cards (one at a time, LayoutAnimation 200ms easeInEaseOut)
  showing consequence, source, confidence, policyNumber. Add modal with
  horizontal category chip selector.
- `horizon.tsx` — 14–90-day deadlines. Noted (state=active w/ notedAt) +
  Rest buttons. "View Vault →" link above Back.
- `compass.tsx` — Conditional render. <7d household age → "Compass gets
  smarter with time." ≥7d → five cards: Household Pulse, Top Signal
  Sources, Signal Type Breakdown (stacked resolved/held/expired), Peak
  Days (Mon–Sun bar chart), Resolution Speed.
- All four use top-left "← Return" link (single back affordance,
  matching iOS pattern + back-swipe gesture).

### Components

- `Minimap.tsx`, `FinaleSheet.tsx`, `AddSignalSheet.tsx`,
  `YesterdayModal.tsx`, `OverwatchView.tsx`, `HealthContext.ts`,
  `signalTypes.ts`.

### FinaleSheet (signal-tap modal)

- Meta block → **NEXT STEP** muted label + brass italic suggestion text
  from `/api/suggest` → Hold/Rest action buttons. "…" placeholder while
  fetching. Silent failure leaves the section unmounted.
- **Edit mode** for single-signal correction: tap an editable field →
  inline TextInput → save PATCHes the signal back to the server.
- Re-renders cleanly on tap-different-signal; in-flight fetches
  cancelled via local `cancelled` flag.

### Onboarding

`app/onboarding.tsx` — first-run flow pre-OAuth.

---

## 11. OTA Update Pipeline

EAS Update is wired and live as of `3dcc5df` (auto-installed by first
`eas update` run) + `dd358cb` (channel mapping fix).

- **`app.json`**: `runtimeVersion: { policy: "appVersion" }` ties OTA
  compatibility to the app's marketing version. `updates: { url:
  "https://u.expo.dev/04f4211f-..." }` is the EAS Update endpoint the
  installed app polls on launch.
- **`eas.json`**: preview profile carries `channel: "preview"` — earlier
  builds without this field could not receive OTAs (the device polled
  with no channel header and EAS returned nothing). **The eb4d78f3
  build embedded no channel and cannot be retrofitted**; the next
  preview build (`754a2432`, commit `dd358cb`) was the first
  OTA-receiving binary in practice.
- **`expo-updates`** ^29.0.17 is in `package.json`. Native modules built
  in.
- **Push OTA** from desktop: `eas update --branch preview --message
  "..."` — applies to all installed `preview`-channel builds with a
  matching `runtimeVersion`.

### Sarah's install link (as of 2026-05-15)

- Build ID `754a2432-a010-478b-87af-402f4e919cfa`, commit `dd358cb`.
- IPA: `https://expo.dev/artifacts/eas/fu3enqjybwBWAXCoYo6CCs.ipa`.
- New mobile features past commit `dd358cb` (Crew Household section,
  FinaleSheet suggestion, etc.) require a fresh preview build or — for
  JS-only changes — an OTA push.

---

## 12. Roadmap

### Built and verified in production (last two sessions)

- **Suggestion engine** — POST `/api/suggest`, 12h Redis cache, Haiku-
  generated per signal, surfaced in FinaleSheet + prefetched on Hover.
- **Travel prep intelligence** — 72h pre-departure brief mode with
  flight + accommodation + pre-departure deliveries + same-day conflicts
  + destination extraction. Sentence cap lifts to 7 in travel mode.
- **Crew screen + household members** — auto-populate on join, edit-
  modal for birthday/anniversary, mobile screen with Household / Children
  / Pets sections, two entry points (Hover wheel + Settings).
- **Birthday + anniversary awareness** — Job 4 Gmail extraction pass,
  `user:{id}:profile.birthday`/`.anniversary` fields drive the brief's
  household-birthday loop, Edit modal POST path mirrors to crew record.
- **Personal/family view toggle** on Hover — AsyncStorage-backed,
  filters signals by ownership.
- **Work calendar privacy** — `stripToTimeBlock()`, free-text
  `workCalendarName` preference. Title/description/attendees/location
  never persisted for work events.
- **Email-confirmation signal updates** — reservation/appointment
  parsers improved for confirmation emails.
- **Brief quality rules**:
  - Day-count and date lift-don't-compute (`(in N days)`, `(yesterday)`,
    `(already passed N days ago)`, weeks-form for clean multiples of 7).
  - Horizon-closer phrase whitelist + tighter 14d threshold.
  - Banned weather-closer phrases.
  - Banned inter-signal relative-duration phrases.
  - Single-member household ownership collapse.
  - Segmenter cross-pool signalId borrowing rejection.
  - Auto-expiry: incoming + no ETA + age >7d.
  - The Read (4th Claude call, collapsible overflow).
  - Past-dated framing direction enforced.
- **OTA pipeline** — `expo-updates` wired, `preview` channel mapping,
  `runtimeVersion: appVersion` gating.
- **Push body parity** — Notify uses cached `user:{id}:currentTakeoff`
  first sentence so push and in-app brief read identically.
- **Onboard fan-out** — 4 parallel QStash messages + horizon chain. Per-
  job hash-backed status storage.
- **Cron** — morning sync at 10:45 UTC, takeoff notify at 11:00 UTC (15-
  min stagger eliminates the parallel-cron read race).
- **Mobile vocabulary sweep** — Conductor language throughout (Programme,
  Awareness, Crew, Vault, Compass, The Horizon, The Read, Overwatch,
  Yesterday, Rest, Hold, Noted).
- **New mobile full-screen routes** — Compass, Vault, Horizon, Crew.
  Missed Cues as tab-bar-hidden route.
- **Add Signal flow** — sheet inside Hover legend wheel, freshly-added
  pulse on radar.
- **Yesterday modal** + **Overwatch view** + **The Read collapsible** +
  **thumbs feedback row** on Ground.
- **FinaleSheet edit mode** for single-signal correction.
- **HealthKit query option-shape fix** — kingstinct v14 expects
  `{filter: {date: {startDate, endDate}}, limit}` not `{from, to, limit}`.

### Planned (named, not yet built)

- Sync cron self-healing for partial onboarding failures (vault/crew/
  horizon don't re-run on subsequent syncs if they failed during
  onboarding).
- Multi-household onboarding polish.
- Cron monitoring / alerting.
- Importance-time peak-days bucket (currently bucketed on `actionAt`).

### Known issues / debt

- `clearance.js` and `brief.js` duplicate `classifyUrgent`,
  `isInNearWindow`, `dayOffsetFromToday`, `withinNextDays`,
  `computeRing`, `buildHouseholdNameMap`, `ownershipTag`,
  `daysFromTodayPhrase`. Worth lifting into `api/_shared.js` next time
  the area is touched.
- Push registration always POSTs on cold start (no cache-gated dedup).

---

## 13. Costs

**No measured monthly burn data is available.** Framework for tracking:

| Provider | Plan | Cost driver |
|---|---|---|
| Vercel | Pro | Function execution time, bandwidth |
| Upstash Redis | Pay-as-you-go | Commands per month |
| Anthropic | Claude Haiku 4.5 | Input + output tokens |
| Apple Developer | $99/yr fixed | — |
| Expo Push / EAS Update | Free tier | — |
| Expo EAS Build | Free tier or paid | Build minutes |

Per brief: **4 Claude calls** (main + segment + transparency + The Read),
~3K input + ~1.2K output tokens. Per import: 1 call per email parsed.
Per signal tap: 0 calls on cache hit, 1 Haiku call on miss (12h TTL).

---

## 14. Environment Variables

| Variable | Used in |
|---|---|
| `UPSTASH_REDIS_REST_URL` | Every endpoint that touches Redis |
| `UPSTASH_REDIS_REST_TOKEN` | Every endpoint that touches Redis |
| `ANTHROPIC_API_KEY` | `brief.js`, `clearance.js`, `import.js`, `calendar.js`, `notify.js`, `parse.js`, `onboard-worker.js`, `suggest.js` |
| `GOOGLE_CLIENT_ID` | `auth.js`, `callback.js`, `refresh.js` |
| `GOOGLE_CLIENT_SECRET` | `callback.js`, `refresh.js` |
| `QSTASH_TOKEN` | `onboard.js` (4-message fan-out) |
| `QSTASH_CURRENT_SIGNING_KEY` | `onboard-worker.js` |
| `QSTASH_NEXT_SIGNING_KEY` | `onboard-worker.js` |
| `ADMIN_SECRET` | `admin.js` (quality dashboard) — endpoint returns 401 when unset |
| `GOOGLE_PLACES_KEY` | `places.js` — extractSignalLocation (Places Text Search) |
| `GOOGLE_MAPS_KEY` | `places.js` — getTravelTime (Distance Matrix). Falls back to `GOOGLE_PLACES_KEY` if the Maps API is enabled on the same key |
| `EVENTBRITE_API_KEY` | `events.js` — fetchLocalEvents (private OAuth token from eventbrite.com/account/api-keys) |

Each integration is credential-gated and degrades silently to a no-op
when the relevant key isn't set. Add a key + redeploy → the feature
activates automatically.

Mobile: `app.json` carries `expo.extra.eas.projectId` and the OTA
`updates.url`. No other secrets.

---

## 15. Build Commands

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

> **Vercel auto-deploy is broken since 2026-05-14.** Git pushes no
> longer trigger production deploys. After every backend commit, run:
>
> ```
> vercel --prod --yes
> ```
>
> Then confirm with `vercel ls --prod` — the top row's "Age" should be
> seconds/minutes, not hours, and the Username should be your Vercel
> user (not `vercel[bot]`). Behavioral tests against the production URL
> must wait for a fresh deploy or they'll hit the old build.
>
> Root cause is the Vercel ↔ GitHub App integration on this project —
> not a code-level fix. To repair (dashboard-only, can't be done via
> the CLI):
>
> 1. Open `vercel.com/jamestotalhome-5918s-projects/conductor`
> 2. Settings → Git → "Disconnect from Git"
> 3. "Connect Git Repository" → choose `JamesFTL/conductor`
> 4. Verify the "Production Branch" field is set to `master`
> 5. Push a trivial commit to master and watch the Deployments tab —
>    a new entry should appear within ~30s, attributed to `github` /
>    `vercel[bot]` rather than your CLI user
> 6. If still no deploy fires: go to `github.com/settings/installations`,
>    find the Vercel app, click Configure, re-grant repo access to
>    `JamesFTL/conductor`

### Admin quality dashboard (`api/admin.js`)

The quality dashboard is secret-gated. To activate:

```
vercel env add ADMIN_SECRET production
# paste a strong random string (e.g. `openssl rand -hex 32`)
vercel --prod --yes
```

Then query:

```
curl 'https://conductor-ivory.vercel.app/api/admin?action=quality&secret=YOUR_SECRET'
```

Returns `{ last24hAvg, byHousehold (sorted worst-first), recentLowScores }`.
Defaults to 401 when ADMIN_SECRET isn't set so the endpoint is safe to
leave deployed without credentials.

### Mobile (from `C:\Users\james\conductor-mobile`)

| Task | Command |
|---|---|
| Start dev client | `npm run start` |
| Lint | `npm run lint` |
| iOS preview build (internal IPA) | `eas build --platform ios --profile preview` |
| iOS dev client build | `eas build --platform ios --profile development` |
| iOS production build | `eas build --platform ios --profile production` |
| List recent builds | `eas build:list --platform ios --limit 5` |
| Inspect credentials state | `eas credentials --platform ios` |
| Confirm Expo login | `eas whoami` |
| **Push an OTA update** | `eas update --branch preview --message "..."` |
| List channels | `eas channel:list` |

### Cron schedule (`vercel.json`)

```
45 10 * * *   /api/sync                         # 6:45 AM ET — 15min before takeoff
 0 11 * * *   /api/notify?type=takeoff          # 7:00 AM ET
 0  1 * * *   /api/sync                         # 9:00 PM ET — pre-clearance
 0  2 * * *   /api/notify?type=clearance        # 10:00 PM ET
```

UTC throughout. EDT shifts schedules one hour later in local time.

---

*Last updated against backend commit `0235d14` (Suggestion engine) and
mobile commit `0819098` (FinaleSheet next-step). Sarah's deployed IPA is
build `754a2432`, commit `dd358cb`.*
