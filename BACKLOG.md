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
- [ ] **Notifications & wake-up alarm** — wake-up time alarm, an evening reminder to
      log the day (check-in, meals, supplements), and a prep-for-tomorrow nudge
      (session preview, kit out, meals planned). Set during the setup journey and
      editable in Me → Settings. Android: Capacitor local-notifications (exact alarms
      need the SCHEDULE_EXACT_ALARM permission); web PWA gets best-effort notifications
      only — position the Android app as the alarm home.
- [ ] **Supplements tracking** — daily supplement checklist (protein shake, CLA gels;
      user-editable list) as check-in pills with streaks; taken/missed feeds the
      Consistency pillar and Vic's context; reminded by the evening notification above.
- [ ] **Backdated food logging** — log a meal against any past day (date picker in the
      log/photo sheets, same pattern as the check-in day selector); Logged-meals card
      and Fuel scoring already group by day so they pick it up automatically.
- [ ] **Sleep-question clarity** — every sleep/evening item states exactly which night
      it means ("How did you sleep LAST night (Wed→Thu)?", "Screens YESTERDAY evening?");
      matters most when back-filling a previous day from the check-in day selector.
- [ ] **Desktop companion site** — rich desktop UX for the same data: responsive
      multi-column layout (score + trends + plan + food diary side by side), bigger
      charts, keyboard-friendly logging, Vic chat in a persistent side panel. Same
      PWA/Supabase backend — a layout tier above 900px rather than a separate app.

## After all features ship

- [ ] **✨ Engaging UI refresh** — a full design pass once the feature set is stable:
      motion and micro-interactions (score ring animation, session-complete celebration,
      streak moments), richer data-viz for score/trend/impact charts, Vic personality in
      the visual language (his voice in empty states and milestones), bolder typography
      and colour system evolved from the current navy/lime, dark/light themes, and a
      polish pass on one-hand ergonomics. Scope it as a dedicated design sprint with
      before/after screens — features first, then beauty, so the redesign wraps real,
      stable workflows.
