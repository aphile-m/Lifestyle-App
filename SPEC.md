# Trainer App — Feature Specification

**Name:** *Trainer App*
**Platforms:** Android (Capacitor) + Web (installable PWA)
**Version:** Spec v1.4 — 2026-07-22
**Owner:** Aphile M

---

## 1. Vision

A holistic, AI-powered personal trainer that treats training, food, recovery, and daily life
as one system — not four separate apps. The AI coach knows what you cooked (Aphile's
Cookbook), what you trained (Strava), what your week looks like (Google Calendar), and what
keeps you moving (Spotify), and uses that full picture to coach you toward your goals with
the warmth and accountability of a real trainer.

**Primary goal (v1):** weight loss through sustainable lifestyle changes — no crash
protocols, no unsustainable restriction. Progress is made *measurable* by the *Lifestyle
Score* (§3): a benchmark of where you are today and an aggregate measure of improvement over
time, with breakdowns and insights across every lifestyle area. The coach optimises the
score's inputs (behaviours), and the outcomes (trend weight, fitness) follow.

**Design north stars**

1. **One coach, one conversation.** Every feature is reachable through, and enriched by, a
   persistent AI coach that remembers your history and goals.
2. **Holistic, not fragmented.** Training load, nutrition, sleep/recovery, and schedule are
   scored and presented together. No silos.
3. **Low-friction logging.** If it takes more than ~10 seconds to log something, people stop.
   Photo, voice, and automatic sync (Strava/cookbook) do the heavy lifting.
4. **Proven architecture.** Reuse the cookbook's stack that already works for you:
   single-codebase web app, Capacitor Android shell, OTA updates, bring-your-own Anthropic
   key, offline-first.
5. **Private by default.** Health data stays on-device / in your own Supabase project. The
   Anthropic key is stored only on-device, exactly like the cookbook.

---

## 2. The Coach (core AI experience)

The centerpiece: **Vic**, a persistent AI personal trainer powered by the Claude API.

**Vic's persona (decided):** slightly patient but **no excuses** — he'll hear you out
once, then redirect straight to the next action ("okay, knees are sore — we swap squats,
we don't skip the session"). He inspires and encourages better behaviour rather than
scolding, celebrates real wins with specifics, and regularly drops knowledgeable
**"Did you know…"** micro-insights tied to (a) your actual progress data ("did you know
your sleep consistency is up 22% since baseline?") and (b) the evidence behind whatever
he's asking you to focus on or improve ("did you know protein at breakfast measurably
reduces evening snacking?"). Facts must be real and, where personal, drawn from your
logged data — never invented.

### 2.1 Coach conversation
- Full-screen chat home tab: ask anything ("swap tonight's session, my knees are sore"),
  log by talking ("had two eggs and toast"), or get a plan explained.
- **Voice input** (Android speech-to-text) for hands-free logging mid-workout or mid-cook.
- Streaming responses; quick-reply chips for common actions ("Log it", "Adjust plan",
  "Show alternatives").
- **Tone dial** (persona stays Vic): more gentle ↔ more direct; concise ↔ chatty. The
  no-excuses core and did-you-know habit are constants.

### 2.2 Coach memory & context
- Structured **athlete profile**: goals, injuries, food preferences/allergies, schedule
  constraints, personal records. Editable — you can always see and correct what the coach
  believes about you.
- **Equipment registry** (drives every plan Vic writes): dumbbells, bench, Swiss ball,
  stepper, skipping rope, resistance bands, ankle weights, walker/treadmill — plus street
  running and bodyweight work as preferred modalities. Editable as kit changes.
- **Session time budget**: default **60 minutes including warm-up and cool-down**,
  adjustable per session ("only got 30 today" → Vic compresses, never cancels).
- **Rolling summaries**: weekly digests of training, nutrition, and adherence are stored and
  fed back into context so the coach genuinely "remembers" months of history without
  blowing the context window.
- **Claude tool use**: the coach calls typed tools (read Strava activities, read cookbook
  recipes, write workout log, create calendar event, build playlist) rather than
  hallucinating data. Every write action is confirmed in the UI before it commits.

### 2.3 Daily brief
- Morning card (and optional notification): today's planned session, readiness verdict from
  yesterday's load + sleep, meal suggestion pulled from the cookbook that fits today's
  macro target, and any schedule conflicts spotted on the calendar.
- Evening check-in: 30-second review — how did the session feel (RPE), quick mood/energy
  score, tomorrow preview.

### 2.4 Adaptive coaching engine — structured periodisation
Plans are generated **only after the measure-and-benchmark session** (§3.4) — Vic won't
prescribe before he's measured. Every plan has an explicit three-level hierarchy, because
structure and forward planning are the point:

- **Monthly theme (mesocycle)** — one clear focus per 4-week block ("Foundation: build
  the habit, protect the joints"), with the why spelled out against your goal and data.
- **Weekly focus (microcycle)** — what this week is for within the theme ("Week 3: add a
  set everywhere — peak week before we deload") and how many sessions it expects.
- **Workout of the Day (WOD)** — the concrete session: warm-up → main block(s) →
  cool-down, fitted to the session time budget (default 60 min all-in) and built ONLY
  from registered equipment, street running, and bodyweight work.

Vic **guides you through** the plan, not just hands it over: the daily brief frames the
day's session against the weekly focus; the workout player walks it exercise by exercise;
the weekly review closes the week against its focus.

- Progression rules are explicit in the planning prompts, not vibes: progressive overload
  week to week, a deload roughly every 4th week, injury-aware substitutions, and
  **sustainable-and-attainable targets** — the next step is always small enough to hit.
- **Re-plans continuously**: missed session → redistributes load; Strava shows an
  unplanned 20 km ride → tomorrow becomes recovery; travel on the calendar → hotel-room
  bodyweight session. The monthly theme survives re-planning; only the path adjusts.

---

## 3. Lifestyle Score (benchmark & progress measurement)

The app's measurement backbone: one aggregate number that answers "where am I now, and am I
actually improving?" — with honest breakdowns underneath so it never becomes a vanity
metric.

### 3.1 Baseline benchmark
- **Calibration fortnight** at onboarding: a short self-assessment questionnaire plus two
  weeks of normal observed data (Strava, food logs, sleep check-ins, habits) establish the
  **baseline score** before coaching pressure begins. The coach explicitly frames it:
  "live normally for two weeks so we know the honest starting line."
- Baseline is stored immutably and every later view shows **delta vs. baseline**, not just
  the raw number.

### 3.2 Score model
- Aggregate **Lifestyle Score 0–100**, a weighted blend of five pillar sub-scores
  (each 0–100):

  | Pillar | Measures | Weight (weight-loss profile) |
  |---|---|---|
  | **Move** | Training sessions completed, weekly load vs. plan, daily activity | 25% |
  | **Fuel** | Adherence to kcal/protein targets, meal quality, home-cooked ratio | 30% |
  | **Recover** | Sleep consistency & quality, readiness trend, rest-day compliance | 20% |
  | **Consistency** | Habit completion, logging streaks, plan adherence over weeks | 15% |
  | **Body** | Trend-weight trajectory vs. sustainable target rate (not absolute weight) | 10% |

- Weights are goal-profile dependent (a future muscle-gain profile would weight Move/Fuel
  differently) and visible in settings — no black box.
- **Behaviour-heavy by design**: 90% of the score is things you *do* (controllable), only
  10% is the outcome (Body). Sustainable-change philosophy encoded in the math: a bad
  scale week can't wreck the score if the behaviours held.
- Scores are computed from data already captured elsewhere in the app — the score adds no
  logging burden of its own.
- Computed daily, but the **weekly score is the headline** (7-day window) to dampen noise;
  monthly rollups for long-range trends.

### 3.3 Progress views & insights
- **Today tab**: current weekly score chip with 7-day sparkline.
- **Me → Progress**: score timeline since baseline (week/month/quarter zoom), stacked
  pillar breakdown showing *which* areas drive each change, and per-pillar drilldowns down
  to the underlying logs.
- **Impact analysis engine** (industry-standard methodology, per Whoop Journal / Garmin
  Lifestyle Logging): a behaviour's impact on next-day/next-night metrics is only reported
  once there are **≥5 "yes" and ≥5 "no" instances within a rolling 90-day window**; shown
  as effect size on the affected metric ("late caffeine → sleep score −9 on average") with
  a confidence hint, worded as correlation, never causation. A **monthly impact report**
  (Whoop MPA-style) ranks your tracked behaviours by measured effect.
- **Coach insights** (weekly review + on demand): plain-language analysis, always naming
  the biggest win and the biggest drag — "Score up 4: sleep consistency did the work.
  Fuel dipped Thursday–Saturday; want the weekend meal plan adjusted?" Cross-pillar
  correlations from *your* data ("weeks you sleep 7h+, your Fuel adherence runs ~12 points
  higher") once enough history exists.
- **Re-benchmark ritual every 8 weeks**: formal before/after comparison against baseline
  and against the previous block — aggregate delta, per-pillar deltas, and the coach's
  narrative of what changed. This is the moment the app proves the plan is working (or
  triggers an honest re-plan if it isn't).
- Shareable progress card (optional) showing score trajectory without exposing weight.

### 3.4 Measurement & benchmarking protocol
Progress tracking at appropriate intervals, each metric on the cadence where change is
actually visible — measuring more often than the body can change just manufactures noise
(Vic explains this when someone tries):

| What | Measures | Cadence |
|---|---|---|
| **Body weight** | scale weight → 7-day trend | ad lib (daily ok); trend is the headline |
| **Body measurements** | waist, hips, chest, arms, thighs (cm) | every **4 weeks** |
| **Fitness benchmarks** | resting HR; timed 1.6 km run (or brisk walk test) | every **8 weeks** |
| **Strength benchmarks** | push-up max, plank hold, goblet squat reps @ fixed dumbbell | every **8 weeks** |

- The **initial measuring session is the gate**: Vic's first plan is generated from it,
  and he walks you through taking each measurement correctly.
- 8-week benchmarks align with the **re-benchmark ritual** (§3.3) so fitness, strength,
  tape and Lifestyle Score deltas land in one before/after review.
- The app surfaces "measurements due" when a cadence lapses; Vic nags precisely once.

---

## 4. Train

### 4.1 Workout library & player
- Session player: exercise cards with sets × reps × load, rest timers with notification
  beeps (reuse cookbook timer/alarm engine), demo notes, and one-tap "done / harder /
  easier" per set.
- Exercise substitution: long-press any exercise → coach offers equivalent alternatives for
  your equipment and injury list.
- Log-as-you-go with plate-math helper and last-time-vs-this-time comparison.

### 4.2 Strava integration (read)
- Auto-import runs/rides/swims: distance, pace, HR zones, relative effort.
- Imported activities count toward weekly load and can **satisfy planned sessions**
  ("today's Zone 2 run" auto-completes when the matching Strava activity lands).
- Training load chart: acute vs. chronic load (ACWR-style) with plain-language
  interpretation from the coach, not just a graph.

### 4.3 Spotify integration
- One-tap **workout playlist** generation matched to session type (intervals → high BPM,
  Zone 2 → steady, yoga/mobility → calm) via Spotify playlist creation.
- "What was playing during my PR" fun stat.

---

## 5. Fuel (cookbook integration — the differentiator)

Aphile's Cookbook stays the standalone cooking companion; the Lifestyle app becomes its
nutrition brain. Integration is two-way.

### 5.1 Recipe sync
- Cookbook recipes sync into the lifestyle app (see §5.5 and §9). Each recipe gets an
  AI-estimated **nutrition profile** (kcal, protein/carbs/fat per serving) computed once by
  Claude and cached; user-correctable.

### 5.2 Meal planning
- Weekly meal plan generated from *your own recipes first*, filtered by macro targets,
  **live pantry contents (read from the cookbook, §5.5)**, and training day type
  (higher-carb on hard days, protein floor daily).
- Gaps filled with coach-suggested simple meals, which can be **exported to the cookbook**
  as new recipes (reusing the cookbook's existing import format).
- Plans are drafted by the coach, then **agreed** with you (accept / swap meals per day)
  before anything syncs — only agreed plans are pushed to the cookbook.
- Meal plan → **combined shopping list** (plan ingredients minus what the pantry already
  holds), pushed to the cookbook's shopping list so there is exactly one list at the shop.

### 5.3 Frictionless food logging
- **Photo logging**: snap the plate → Claude vision estimates the meal and portions →
  confirm/adjust in one tap. (Same camera + downscale pipeline the cookbook already uses
  for recipe import.)
- "I cooked X from the cookbook" → logs a serving with its cached nutrition, zero typing.
- Voice/text natural-language logging via the coach chat.
- Deliberately **not** a barcode-database calorie counter: estimates + trends over false
  precision. The coach explains this philosophy to the user.

### 5.4 Nutrition coaching
- Daily targets (kcal + protein floor + rough carb/fat split) set by the planning engine
  and adjusted weekly from actual trend weight and adherence — the coach closes the loop
  instead of using static formulas.
- Hydration nudges tied to training sessions and (later) weather.

### 5.5 Cookbook Sync Module (two-way, decided)
A small sync module added to Aphile's Cookbook, connecting both apps through the shared
Supabase project. Optional in the cookbook (it works fully offline without it, as today)
and versioned so either app can update independently via OTA.

**Cookbook → Trainer App (read):**
- **Pantry**: the cookbook's pantry items become the source of truth the meal planner
  reads — "what's in my pantry" is answered from real data, and shopping lists exclude
  what you already have.
- **Recipes**: full recipe library (for nutrition profiling, §5.1) with change detection
  so edits/new imports flow through automatically.
- **Cooked events**: finishing a recipe in the cookbook's cooking mode logs a meal in the
  Trainer App automatically (serving count from the cookbook's servings adjuster).

**Trainer App → Cookbook (write):**
- **Agreed meal plans**: the accepted weekly plan appears in the cookbook as a "This
  week's plan" view — each day linking straight to the recipe and its cooking mode.
- **Shopping list items**: plan-derived, pantry-deduplicated items merge into the
  cookbook's existing shopping list (append + merge by ingredient, never overwrite
  user-added items).
- **New recipes**: coach-suggested meals exported in the cookbook's import format.

**Mechanics:** offline-first queue on both sides — changes are written locally to
IndexedDB, then pushed/pulled through Supabase (Postgres tables + row-level security under
your single user account) when online; last-write-wins per item with the cookbook winning
conflicts on pantry/shopping data (it's the kitchen-side source of truth) and the Trainer
App winning on plans. No sync while the cookbook has no key/account configured — the
module ships dormant until connected.

---

## 6. Recover & Wellbeing (the "holistic" pillar)

- **Readiness score** each morning from: self-reported sleep quality (or Health Connect
  sleep data when available), yesterday's load, muscle soreness quick-tap body map, and
  mood/energy check-in. Score gates the day's plan intensity.
- **Sleep**: bedtime consistency tracking with a gentle wind-down notification; coach flags
  the sleep–performance correlation when it appears in *your* data.
- **Mobility & rest-day content**: short guided mobility/stretch sessions in the workout
  player format; scheduled automatically on rest days.
- **Habit tracker**: up to ~5 user-chosen daily habits (steps, water, reading, no-late-
  caffeine…), streaks shown honestly (streak freezes exist; guilt-tripping doesn't).
- **Weight & measurements**: trend-weight (7-day EMA) is the headline number, never the
  daily spike; progress photos stored locally/in your Supabase only.
- **Lifestyle Journal (behaviour tags)** — Whoop-Journal / Garmin-Lifestyle-Logging style,
  feeding the impact engine (§3.3):
  - Pick ~5–15 behaviours to track from a catalogue (late caffeine, alcohol, late meal,
    screens in bed, cold shower, sauna, stretching, reading before bed, illness, injury,
    travel, late work…); custom tags allowed.
  - Logged as **one-tap chips inside the evening check-in** — journaling adds seconds, not
    a new screen to remember.
  - **Auto-tagging is the differentiator** over Garmin/Whoop, where every tag is manual:
    the app already *knows* many behaviours — "home-cooked meal" and "late dinner" from
    cookbook cooked-events and food-log timestamps, "training day"/"double session" from
    Strava, "travel"/"late meeting" from Calendar, "late caffeine" prompted when a coffee
    is logged after 14:00. Auto-tags are shown for confirmation, not silently assumed.
- **Watch data (Garmin Vivoactive 4)** via Android Health Connect (Garmin Connect exports
  to Health Connect): sleep stages/score, resting HR, stress, Body Battery, steps,
  Pulse Ox. This makes most of the Recover pillar automatic instead of self-reported.
  Known device limits: the Vivoactive 4 has **no skin-temperature sensor and no HRV
  Status**, so those signals are out of scope — and Garmin's own new features may not
  fully support this older watch, which is exactly why the app runs its *own* journal and
  impact engine on the watch's raw metrics rather than depending on Garmin Connect's.
- **Baseline deviation flags** (Garmin Health-Status-inspired): after the calibration
  period establishes typical ranges for resting HR, sleep score/duration, and stress, the
  app flags multi-day deviations ("RHR 6 bpm above your baseline for 3 nights") and the
  coach *acts* on them — easing the plan, suggesting an early night, asking whether you're
  getting sick — rather than just displaying a warning banner.

---

## 7. Life (schedule & motivation)

- **Google Calendar integration**: planned sessions are written to your calendar as events;
  the planner reads busy blocks to schedule sessions realistically, and re-plans around
  conflicts ("your Thursday is stacked — moving intervals to Friday morning?").
- **Weekly review**: Sunday coach message — what went well, adherence %, one focus for next
  week. Also a shareable recap card (image) if you want to post it.
- **Milestones & PRs**: personal records, badges for consistency (not just intensity), and
  goal countdowns (e.g. race day).
- **Notifications policy**: few and meaningful — daily brief, session reminder, evening
  check-in, weekly review. Everything else is opt-in. All local notifications (cookbook
  pattern), no push infrastructure required for v1.

---

## 8. Screens (information architecture)

Bottom nav, five tabs:

| Tab | Contents |
|---|---|
| **Today** | Daily brief, Lifestyle Score chip + sparkline, readiness, today's session + meals, quick-log buttons |
| **Coach** | Persistent chat with the AI trainer (voice + text) |
| **Train** | Plan calendar, workout player, Strava feed, load charts |
| **Fuel** | Meal plan, food log, macro rings, cookbook recipe browser |
| **Me** | Lifestyle Score timeline + pillar breakdowns, progress (trend weight, PRs, photos), habits, profile/goals, settings |

Onboarding: goal wizard (weight-loss profile is the tuned default) → connect services
(Strava, Calendar, Spotify, cookbook sync, Anthropic key) → coach introduces itself and
starts the two-week baseline calibration (§3.1) before the first full plan. Each connection is
skippable; the app degrades gracefully to manual logging.

Accessibility & UX baselines: one-hand reach for all primary actions, large tap targets in
workout player (sweaty thumbs), dark mode, offline-first with visible sync state, WCAG AA
contrast, no data ever lost on airplane mode.

---

## 9. Architecture

Mirrors the cookbook's proven setup, plus a thin sync layer.

- **Client:** installable PWA (service worker, offline-first) — same codebase ships to
  Android via **Capacitor 8** (`@capacitor/app`, `camera`, `local-notifications`) with
  **@capgo/capacitor-updater** OTA updates and the same GitHub Pages / release workflow.
  Recommend graduating from a single 171 KB `index.html` to a lightly modularised vanilla
  JS + small build step (esbuild) — same philosophy, maintainable at this app's size.
- **AI:** Claude API, bring-your-own key stored on-device (cookbook pattern). Model
  routing: fast/cheap model (Haiku-class) for logging parses and quick answers; stronger
  model for weekly planning and photo nutrition estimates. All coach actions via tool use.
- **Data:** local-first in IndexedDB (cookbook pattern) with **Supabase — reusing the
  cookbook app's project (decided)** — as sync + backup: auth, Postgres for logs/plans/profile, storage for progress
  photos. Web and Android stay in sync; the Cookbook Sync Module (§5.5)
  rides the same Supabase project — pantry/recipes/cooked-events in, agreed meal plans and
  shopping items out.
- **Integrations:** Strava API (OAuth, activity read + webhook later), Google Calendar API
  (event read/write), Spotify Web API (playlist create), **Android Health Connect** for
  Garmin Vivoactive 4 data (sleep, resting HR, stress, Body Battery, steps — Garmin
  Connect syncs into Health Connect on Android; the Android app relays it to Supabase so
  the web app sees it too).
- **Privacy:** no third-party analytics; health data only on-device + your Supabase
  project; API key never leaves the device except to Anthropic; one-tap full export (JSON)
  and delete-everything.

---

## 10. Phased roadmap

**MVP (v1) — "benchmark me, coach me, feed me"**
Onboarding + goal wizard (weight-loss profile) · **Lifestyle Score: calibration fortnight,
baseline benchmark, weekly score + pillar breakdown** · coach chat with memory + profile ·
plan generation & adaptive re-planning · workout player with logging + rest timers ·
Strava read sync · **Cookbook Sync Module: pantry + recipes in, agreed meal plans +
shopping list out** · recipe nutrition estimates · photo/voice/"cooked from cookbook" food
logging · daily brief + evening check-in **with journal quick-tag chips** · trend weight ·
Health Connect read (Garmin sleep/RHR/stress/Body Battery) · Supabase sync (shared
cookbook project) · PWA + Android builds with OTA.

**v2 — "holistic"**
Readiness score + soreness body map · **impact analysis engine (5×5/90-day rule) + monthly
impact report** · **behaviour auto-tagging from cookbook/Strava/Calendar** · **baseline
deviation flags with coach follow-through** · cross-pillar score insights & correlations ·
8-week re-benchmark ritual · Google Calendar two-way scheduling · habit tracker · weekly
review + recap card · Spotify workout playlists · cooked-event auto-logging from the
cookbook · mobility content.

**v3 — "deeper"**
Strava webhooks (instant sync) · expanded journal catalogue & custom experiments
("2 weeks no late caffeine — measure it") · hydration & wind-down
nudges · PR badges & goal countdowns · plate-math and advanced strength analytics ·
multi-user (family) support if wanted.

---

## 11. Success criteria

- Aphile logs food and training on ≥5 days/week after week 4 (the retention cliff).
- Median log action ≤10 seconds.
- Coach re-plans correctly after a missed/extra session without manual editing.
- Baseline Lifestyle Score captured within 14 days of install; every week thereafter shows
  a score with pillar breakdowns and at least one actionable insight.
- Lifestyle Score meaningfully above baseline at the 8-week re-benchmark, with trend
  weight moving at a sustainable rate (~0.25–0.75 kg/week average).

## 12. Decisions log

- App name: **Trainer App**. Primary goal: **weight loss through sustainable lifestyle
  changes**, measured via the Lifestyle Score.
- Supabase: **reuse the cookbook app's project** (single shared project, RLS per app).
- Wearable: **Garmin Vivoactive 4** via Health Connect (no skin temp / HRV Status —
  scoped accordingly).
- Weight-loss profile: default sustainable band **~0.25–0.75 kg/week** accepted.
- Cookbook sync: **two-way module** (pantry & recipes in, agreed meal plans & shopping
  list out).
- Inspiration reviewed: DC Rainmaker on Garmin Lifestyle Logging / Health Status vs Whoop
  Journal (2025-09) → adopted journal quick-tags, 5×5/90-day impact methodology, monthly
  impact report, baseline deviation flags, auto-tagging differentiator.
- Coach: **Vic** — slightly patient, no-excuses, inspiring, with data-grounded
  "Did you know" insights (see §2).
- Plan structure: **monthly theme → weekly focus → workout of the day**, generated only
  after the measure-and-benchmark session; Vic guides each session (§2.4).
- Equipment registry: dumbbells, bench, Swiss ball, stepper, skipping rope, resistance
  bands, ankle weights, walker/treadmill + street running + bodyweight preference.
- Session budget: **60 min default** including warm-up and cool-down.
- Measurement cadences: tape 4-weekly; fitness & strength benchmarks 8-weekly (§3.4).
- Supabase host (decided): the shared `trainer_*`/`shared_*` schema lives in the existing
  **"Vinyl Database"** project (free tier at its 2-project cap; tables are namespaced so
  nothing collides). Applied as migration `trainer_app_shared_schema_v1` on 2026-07-22.

## 13. Open questions

None — spec is build-ready. New questions get logged here as they surface during
implementation.
