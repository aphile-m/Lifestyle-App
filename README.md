# Trainer App

**Vic** — your AI personal trainer. Train, fuel, recover, live — one coach, one score.

Full product spec: [SPEC.md](SPEC.md). Companion app: [Aphile's Cookbook](https://github.com/aphile-m/aphiles-cookbook).

## What's here (v0 scaffold)

- **Web app / PWA** in `www/` — vanilla JS ES modules, no build step, offline-first
  (same philosophy as the cookbook, lightly modularised):
  - Five tabs: **Today** (Lifestyle Score, quick log, evening check-in with journal
    quick-tags), **Vic** (coach chat, live against the Claude API), **Train**, **Fuel**,
    **Me** (trend weight, profile, settings).
  - `js/score.js` — Lifestyle Score engine: five weighted pillars (Move 25 / Fuel 30 /
    Recover 20 / Consistency 15 / Body 10), null-safe when a pillar has no data yet.
  - `js/vic.js` — Vic's persona (patient-but-no-excuses, data-grounded "Did you know"s)
    and the Anthropic API call. The key is stored on-device only (Me → Settings).
  - `js/store.js` — settings in localStorage, logs in IndexedDB.
- **`supabase/schema.sql`** — additive schema for the *shared cookbook Supabase project*:
  `trainer_*` tables (logs, scores, plans) + `shared_*` tables (the Cookbook Sync Module
  contract: recipes/pantry/shopping in, agreed meal plans/cooked events across).
- **Capacitor 8 shell config** for the Android build (`capacitor.config.json`,
  `package.json`) mirroring the cookbook's toolchain, including Capgo OTA updates.

## Run it

```bash
node serve.js        # http://localhost:8123
```

Add your Anthropic API key under **Me → Settings** to talk to Vic.

## Android

```bash
npm install
npx cap add android
npm run sync && npm run build:apk
```

## Next up (see SPEC.md §10 roadmap)

Plan generation & workout player · Strava import · cookbook sync module (both sides) ·
photo food logging · Health Connect relay for the Garmin Vivoactive 4 · baseline
calibration + score history in Supabase.
