# Aphile's Lifestyle App — Feature Specification

**Working title:** *Sidekick* (placeholder — see Open Questions)
**Platforms:** Android (Capacitor) + Web (installable PWA)
**Version:** Spec v1.0 — 2026-07-22
**Owner:** Aphile M

---

## 1. Vision

A holistic, AI-powered personal trainer that treats training, food, recovery, and daily life
as one system — not four separate apps. The AI coach knows what you cooked (Aphile's
Cookbook), what you trained (Strava), what your week looks like (Google Calendar), and what
keeps you moving (Spotify), and uses that full picture to coach you toward your goals with
the warmth and accountability of a real trainer.

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

The centerpiece. A named, persistent AI personal trainer powered by the Claude API.

### 2.1 Coach conversation
- Full-screen chat home tab: ask anything ("swap tonight's session, my knees are sore"),
  log by talking ("had two eggs and toast"), or get a plan explained.
- **Voice input** (Android speech-to-text) for hands-free logging mid-workout or mid-cook.
- Streaming responses; quick-reply chips for common actions ("Log it", "Adjust plan",
  "Show alternatives").
- Coach **personality settings**: encouraging / drill-sergeant / clinical; concise / chatty.

### 2.2 Coach memory & context
- Structured **athlete profile**: goals, injuries, equipment, food preferences/allergies,
  schedule constraints, personal records. Editable — you can always see and correct what
  the coach believes about you.
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

### 2.4 Adaptive coaching engine
- Goal wizard at onboarding: primary goal (fat loss / muscle / endurance event / general
  health), target date, weekly time budget, equipment.
- The coach generates a **periodised plan** (mesocycle → weeks → sessions) and then
  **re-plans continuously**: missed session → redistributes load; Strava shows an
  unplanned 20 km ride → tomorrow becomes recovery; calendar shows travel → hotel-room
  bodyweight session.
- Deload weeks, progressive overload, and injury-aware substitutions built into the
  planning prompts as explicit rules, not vibes.

---

## 3. Train

### 3.1 Workout library & player
- Session player: exercise cards with sets × reps × load, rest timers with notification
  beeps (reuse cookbook timer/alarm engine), demo notes, and one-tap "done / harder /
  easier" per set.
- Exercise substitution: long-press any exercise → coach offers equivalent alternatives for
  your equipment and injury list.
- Log-as-you-go with plate-math helper and last-time-vs-this-time comparison.

### 3.2 Strava integration (read)
- Auto-import runs/rides/swims: distance, pace, HR zones, relative effort.
- Imported activities count toward weekly load and can **satisfy planned sessions**
  ("today's Zone 2 run" auto-completes when the matching Strava activity lands).
- Training load chart: acute vs. chronic load (ACWR-style) with plain-language
  interpretation from the coach, not just a graph.

### 3.3 Spotify integration
- One-tap **workout playlist** generation matched to session type (intervals → high BPM,
  Zone 2 → steady, yoga/mobility → calm) via Spotify playlist creation.
- "What was playing during my PR" fun stat.

---

## 4. Fuel (cookbook integration — the differentiator)

Aphile's Cookbook stays the standalone cooking companion; the Lifestyle app becomes its
nutrition brain. Integration is two-way.

### 4.1 Recipe sync
- Cookbook recipes sync into the lifestyle app (see §8 for mechanism). Each recipe gets an
  AI-estimated **nutrition profile** (kcal, protein/carbs/fat per serving) computed once by
  Claude and cached; user-correctable.

### 4.2 Meal planning
- Weekly meal plan generated from *your own recipes first*, filtered by macro targets,
  pantry contents, and training day type (higher-carb on hard days, protein floor daily).
- Gaps filled with coach-suggested simple meals, which can be **exported to the cookbook**
  as new recipes (reusing the cookbook's existing import format).
- Meal plan → **combined shopping list**, pushed to the cookbook's shopping list so there
  is exactly one list at the shop.

### 4.3 Frictionless food logging
- **Photo logging**: snap the plate → Claude vision estimates the meal and portions →
  confirm/adjust in one tap. (Same camera + downscale pipeline the cookbook already uses
  for recipe import.)
- "I cooked X from the cookbook" → logs a serving with its cached nutrition, zero typing.
- Voice/text natural-language logging via the coach chat.
- Deliberately **not** a barcode-database calorie counter: estimates + trends over false
  precision. The coach explains this philosophy to the user.

### 4.4 Nutrition coaching
- Daily targets (kcal + protein floor + rough carb/fat split) set by the planning engine
  and adjusted weekly from actual trend weight and adherence — the coach closes the loop
  instead of using static formulas.
- Hydration nudges tied to training sessions and (later) weather.

---

## 5. Recover & Wellbeing (the "holistic" pillar)

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

---

## 6. Life (schedule & motivation)

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

## 7. Screens (information architecture)

Bottom nav, five tabs:

| Tab | Contents |
|---|---|
| **Today** | Daily brief, readiness, today's session + meals, quick-log buttons |
| **Coach** | Persistent chat with the AI trainer (voice + text) |
| **Train** | Plan calendar, workout player, Strava feed, load charts |
| **Fuel** | Meal plan, food log, macro rings, cookbook recipe browser |
| **Me** | Progress (weight, PRs, photos), habits, profile/goals, settings |

Onboarding: goal wizard → connect services (Strava, Calendar, Spotify, cookbook sync,
Anthropic key) → coach introduces itself with your first week's plan. Each connection is
skippable; the app degrades gracefully to manual logging.

Accessibility & UX baselines: one-hand reach for all primary actions, large tap targets in
workout player (sweaty thumbs), dark mode, offline-first with visible sync state, WCAG AA
contrast, no data ever lost on airplane mode.

---

## 8. Architecture

Mirrors the cookbook's proven setup, plus a thin sync layer.

- **Client:** installable PWA (service worker, offline-first) — same codebase ships to
  Android via **Capacitor 8** (`@capacitor/app`, `camera`, `local-notifications`) with
  **@capgo/capacitor-updater** OTA updates and the same GitHub Pages / release workflow.
  Recommend graduating from a single 171 KB `index.html` to a lightly modularised vanilla
  JS + small build step (esbuild) — same philosophy, maintainable at this app's size.
- **AI:** Claude API, bring-your-own key stored on-device (cookbook pattern). Model
  routing: fast/cheap model (Haiku-class) for logging parses and quick answers; stronger
  model for weekly planning and photo nutrition estimates. All coach actions via tool use.
- **Data:** local-first in IndexedDB (cookbook pattern) with **Supabase** (your existing
  account) as sync + backup: auth, Postgres for logs/plans/profile, storage for progress
  photos. Web and Android stay in sync; cookbook↔lifestyle recipe/shopping-list sync also
  rides through Supabase (the cookbook gains a small optional sync module).
- **Integrations:** Strava API (OAuth, activity read + webhook later), Google Calendar API
  (event read/write), Spotify Web API (playlist create), Android Health Connect (steps &
  sleep, post-MVP).
- **Privacy:** no third-party analytics; health data only on-device + your Supabase
  project; API key never leaves the device except to Anthropic; one-tap full export (JSON)
  and delete-everything.

---

## 9. Phased roadmap

**MVP (v1) — "a coach that knows my food and my training"**
Onboarding + goal wizard · coach chat with memory + profile · plan generation & adaptive
re-planning · workout player with logging + rest timers · Strava read sync · cookbook
recipe sync + nutrition estimates · photo/voice/"cooked from cookbook" food logging ·
daily brief + evening check-in · trend weight · Supabase sync · PWA + Android builds with
OTA.

**v2 — "holistic"**
Readiness score + soreness body map · Google Calendar two-way scheduling · habit tracker ·
weekly review + recap card · Spotify workout playlists · meal plan → cookbook shopping
list push · mobility content.

**v3 — "deeper"**
Health Connect (sleep/steps) · Strava webhooks (instant sync) · hydration & wind-down
nudges · PR badges & goal countdowns · plate-math and advanced strength analytics ·
multi-user (family) support if wanted.

---

## 10. Success criteria

- Aphile logs food and training on ≥5 days/week after week 4 (the retention cliff).
- Median log action ≤10 seconds.
- Coach re-plans correctly after a missed/extra session without manual editing.
- Measurable progress toward the primary goal at the 8-week review.

## 11. Open questions

1. App name and coach name/persona.
2. Primary goal for *your* first plan (drives which MVP features get polish first).
3. Supabase: reuse an existing project or create a dedicated one?
4. Cookbook sync: comfortable adding a small optional sync module to the cookbook app, or
   should v1 do one-way import (cookbook → lifestyle) only?
5. Wearable in the picture (watch/HR strap) beyond what Strava already captures?
