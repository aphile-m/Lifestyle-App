# Trainer App — Backlog

Living backlog. Items move to ✅ when shipped to the live app. See SPEC.md for the design
each item implements.

## Shipped 2026-07-22

- [x] **Pull-restore** — fresh device rehydrates all logs from Supabase on sign-in
- [x] **Change password** — in the cloud sync sheet (no more chat-transmitted resets)
- [x] **Fuel: recipe browser** — synced cookbook recipes with AI nutrition estimates
      (cached to `shared_recipes.nutrition`), one-tap "cooked this" logging
- [x] **Fuel: meal planning** — Vic drafts the week from your recipes + live pantry;
      agree/swap flow; agreed plan pushes to the cookbook (`shared_meal_plans`) with a
      pantry-deduplicated shopping list (`shared_shopping_items`)
- [x] **Photo food logging** — snap the plate → Claude vision estimate → confirm → logged
      with macros
- [x] **Score history & baseline** — weekly Lifestyle Score upserts to `trainer_scores`;
      baseline row locked after the calibration fortnight
- [x] **Garmin daily metrics (manual)** — quick-entry sheet for sleep score / RHR /
      stress / Body Battery / steps into `trainer_daily_metrics` (stopgap until Health
      Connect below)
- [x] **Strava import** (needs your Strava API app credentials to go live) — Supabase Edge Function proxy (CORS-safe token exchange +
      activity fetch); connect with your own Strava API app credentials; imported
      activities become workouts (deduped by `strava_id`)
- [x] **Cookbook Sync Module (cookbook side)** (on the cookbook branch, ships with its next release) — `www/sync.js` in aphiles-cookbook:
      pushes pantry/recipes/cooked-events up, shows "This week's plan", merges
      trainer-generated shopping items into the cookbook list

- [x] **Setup journey (onboarding)** — gated paged flow: welcome splash → feature intro
      → setup checklist (live ✓ confirmations) → meet Vic → his four requirements step
      by step → unlock. First slice of the UI-refresh direction (motion, Vic's voice in
      the UI) pulled forward.

## Next

- [x] **Health Connect (native)** — shipped android-v5: @capgo/capacitor-health pulls
      steps, sleep duration and resting HR automatically each launch. Sleep score /
      Body Battery stay manual (Garmin doesn't share them with Health Connect).
- [ ] **Impact analysis engine** — 5×5/90-day behaviour insights + monthly impact report
      (SPEC §3.3); needs a few weeks of journal data to be meaningful.
- [ ] **Readiness score & soreness body map** — gates daily plan intensity (SPEC §6).
- [ ] **Google Calendar two-way scheduling** — sessions as events; planner reads busy
      blocks (SPEC §7).
- [ ] **Weekly review + 8-week re-benchmark ritual** — Vic's Sunday message and the
      formal before/after comparison (SPEC §3.3).
- [ ] **Spotify workout playlists** — matched to session type (SPEC §4.3).
- [ ] **Baseline deviation flags** — multi-day RHR/sleep deviations with coach
      follow-through (SPEC §6).
- [x] **Android APK** — shipped (android-v5). OTA pipeline unnecessary: the shell loads
      the live site, so web ships land on next open.
- [x] **App updates that actually install** — shipped android-v7: releases up to v6 were
      each signed with a different throwaway key (the Gradle plugin regenerates the debug
      keystore when it can't find one under `ANDROID_SDK_HOME`), so Android refused every
      update with "package conflicts with an existing package". CI now declares an
      explicit signing config from the committed keystore and fails the build if
      `apksigner` reports any other certificate. In-app: an update sheet with release
      notes at launch (once per version) plus a manual check in Me → App updates.
      **One-time:** uninstall the pre-v7 app before installing v7.
- [x] **Notifications & wake-up alarm** — shipped v54: wake alarm, evening "log the
      day" nudge and a prep-for-tomorrow reminder via `@capacitor/local-notifications`
      (alarm on its own max-importance channel); set as step 5 of the setup journey,
      editable in Me → Settings, re-applied at launch so reboots keep it. Web PWA falls
      back to in-page notifications and says so. **Needs a new Android build to work on
      the phone.**
- [x] **Supplements tracking** — shipped v54: editable stack in the profile, ticked off
      per day in the check-in, feeds a Consistency driver and Vic's context.
- [x] **Backdated food logging** — shipped v54: 7-day picker on the log/photo/confirm
      sheets; Logged-meals now shows a week so backfills are visible.
- [x] **Sleep-question clarity** — shipped v54: every check-in section names the night
      it covers (sleep = the night that ended that morning; evening habits = that day's
      own evening, landing on the next morning), plus a guide-sheet explainer.
- [x] **Desktop companion site** — shipped v54: responsive tier at ≥900px — left rail
      nav, 2-column dashboard (3 above 1700px), Vic's chat in its own column with a
      pinned input, sheets as centred modals. Same PWA/Supabase backend.

## After all features ship

- [ ] **✨ Engaging UI refresh** — a full design pass once the feature set is stable:
      motion and micro-interactions (score ring animation, session-complete celebration,
      streak moments), richer data-viz for score/trend/impact charts, Vic personality in
      the visual language (his voice in empty states and milestones), bolder typography
      and colour system evolved from the current navy/lime, dark/light themes, and a
      polish pass on one-hand ergonomics. Scope it as a dedicated design sprint with
      before/after screens — features first, then beauty, so the redesign wraps real,
      stable workflows.
