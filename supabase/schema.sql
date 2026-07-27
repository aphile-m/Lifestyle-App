-- Trainer App schema — hosted in the shared Supabase project (SPEC §9).
-- DECIDED 2026-07-22: host project is "Vinyl Database" (uaqvqvrflzxulixdrmna);
-- applied there as migration trainer_app_shared_schema_v1.
-- Additive only: namespaced tables, touches nothing else in the project.
-- Two groups:
--   trainer_*  — Trainer App's own data (logs, plans, scores)
--   shared_*   — the Cookbook Sync Module contract (SPEC §5.5), read/written by BOTH apps
-- All tables: single-owner rows guarded by RLS on auth.uid().

-- ---------- helpers ----------
create extension if not exists pgcrypto;

-- ---------- Trainer App core ----------
create table if not exists trainer_profile (
  user_id     uuid primary key default auth.uid(),
  profile     jsonb not null default '{}'::jsonb,   -- goals, injuries, equipment, tone, baseline_start
  updated_at  timestamptz not null default now()
);

create table if not exists trainer_weights (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid(),
  ts          timestamptz not null default now(),
  kg          numeric(5,1) not null check (kg between 20 and 400)
);

create table if not exists trainer_food_logs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid(),
  ts          timestamptz not null default now(),
  description text,
  source      text not null default 'manual',        -- manual | cookbook | photo | voice
  recipe_id   uuid,                                  -- -> shared_recipes.id when source=cookbook
  kcal        int, protein_g int, carbs_g int, fat_g int,
  servings    numeric(4,2) default 1
);
-- rows are editable in place from the app (upserts on user_id+ts)
create unique index if not exists trainer_food_logs_user_ts on trainer_food_logs (user_id, ts);

create table if not exists trainer_workouts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid(),
  ts          timestamptz not null default now(),
  description text not null,
  planned     boolean not null default false,
  completed   boolean not null default true,
  rpe         int check (rpe between 1 and 10),
  strava_id   bigint,                                -- de-dupe against Strava imports
  detail      jsonb not null default '{}'::jsonb     -- sets/reps/loads or activity stats
);

create table if not exists trainer_checkins (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid(),
  day         date not null default current_date,
  sleep_1_5   int check (sleep_1_5 between 1 and 5),
  energy_1_5  int check (energy_1_5 between 1 and 5),
  water_glasses int check (water_glasses between 0 and 30),  -- EFSA ~2 L/day ≈ 8 glasses
  drinks      numeric(4,1),                           -- alcohol UNITS (UK CMO low-risk: ≤14/wk)
  drinks_detail jsonb,                                -- typed counts {beer,wine,spirit,cocktail}
  caffeine_cups int check (caffeine_cups between 0 and 20),  -- coffees (~100mg each; guide ≤4)

  soreness    jsonb not null default '{}'::jsonb,    -- body-map areas (v2)
  unique (user_id, day)
);

create table if not exists trainer_journal_tags (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid(),
  day         date not null default current_date,
  tag         text not null,                         -- 'late_caffeine', 'alcohol', …
  auto        boolean not null default false,        -- auto-tagged (cookbook/Strava/Calendar), confirmed by user
  unique (user_id, day, tag)
);

create table if not exists trainer_daily_metrics (   -- Garmin via Health Connect relay
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid(),
  day         date not null,
  sleep_score int, sleep_minutes int,
  sleep_hours numeric(4,1),                          -- actual sleep duration (Health Connect)
  resting_hr  int, stress_avg int, body_battery_high int, steps int, pulse_ox int,
  unique (user_id, day)
);

create table if not exists trainer_scores (          -- Lifestyle Score history (SPEC §3)
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid(),
  week_start  date not null,
  aggregate   int check (aggregate between 0 and 100),
  pillars     jsonb not null,                        -- {move, fuel, recover, consistency, body}
  is_baseline boolean not null default false,        -- immutable calibration benchmark
  unique (user_id, week_start)
);

create table if not exists trainer_plans (           -- periodised training plans (SPEC §2.4)
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid(),
  created_at  timestamptz not null default now(),
  active      boolean not null default true,
  month_theme text,                                  -- mesocycle theme, queryable
  start_date  date,
  plan        jsonb not null                         -- weeks[] -> {theme, sessions[] -> WOD blocks}
);

create table if not exists trainer_measurements (    -- tape measurements, 4-weekly (SPEC §3.4)
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid(),
  ts          timestamptz not null default now(),
  waist_cm    numeric(5,1), hips_cm numeric(5,1), chest_cm numeric(5,1),
  arm_cm      numeric(5,1), thigh_cm numeric(5,1)
);
-- rows are edited in place during a measuring session; the app upserts on (user_id, ts)
create unique index if not exists trainer_measurements_user_ts on trainer_measurements(user_id, ts);

create table if not exists trainer_benchmarks (      -- fitness/strength tests, 8-weekly (SPEC §3.4)
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid(),
  ts          timestamptz not null default now(),
  resting_hr  int,
  run_1600m_sec int,                                 -- timed 1.6 km run (or brisk walk test)
  pushups_max int,
  plank_sec   int,
  goblet_squat_reps int, goblet_squat_kg numeric(4,1)
);
-- same in-place editing contract as measurements
create unique index if not exists trainer_benchmarks_user_ts on trainer_benchmarks(user_id, ts);

create table if not exists trainer_chat (              -- Vic conversation history (synced)
  id      uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  ts      timestamptz not null default now(),
  role    text not null check (role in ('user','assistant')),
  text    text not null,
  actions jsonb                                        -- [log:...] buttons attached to the reply
);
create unique index if not exists trainer_chat_user_ts_role on trainer_chat(user_id, ts, role);

-- ---------- Cookbook Sync Module contract (SPEC §5.5) ----------
-- Cookbook is source of truth for pantry/recipes/shopping; Trainer App for meal plans.

create table if not exists shared_recipes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid(),
  updated_at  timestamptz not null default now(),
  title       text not null,
  recipe      jsonb not null,                        -- cookbook's native recipe format
  nutrition   jsonb,                                 -- Trainer App's cached AI estimate (per serving)
  source_app  text not null default 'cookbook'       -- cookbook | trainer (coach-suggested exports)
);

create table if not exists shared_pantry_items (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid(),
  updated_at  timestamptz not null default now(),
  name        text not null,
  quantity    text,
  category    text
);

create table if not exists shared_shopping_items (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid(),
  updated_at  timestamptz not null default now(),
  name        text not null,
  quantity    text,
  checked     boolean not null default false,
  source_app  text not null default 'cookbook'       -- merge-by-ingredient; never overwrite user items
);

create table if not exists shared_meal_plans (       -- only AGREED plans sync (SPEC §5.2)
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid(),
  week_start  date not null,
  agreed_at   timestamptz not null default now(),
  plan        jsonb not null,                        -- day -> meals -> recipe_id/free text
  unique (user_id, week_start)
);

create table if not exists shared_cooked_events (    -- cookbook cooking-mode completions -> auto food log
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid(),
  ts          timestamptz not null default now(),
  recipe_id   uuid references shared_recipes(id) on delete set null,
  servings    numeric(4,2) not null default 1,
  consumed    boolean not null default true
);

-- ---------- RLS: owner-only on every table ----------
do $$
declare t text;
begin
  foreach t in array array[
    'trainer_profile','trainer_weights','trainer_food_logs','trainer_workouts',
    'trainer_checkins','trainer_journal_tags','trainer_daily_metrics','trainer_scores',
    'trainer_plans','trainer_measurements','trainer_benchmarks','trainer_chat','shared_recipes','shared_pantry_items','shared_shopping_items',
    'shared_meal_plans','shared_cooked_events'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'drop policy if exists owner_all on %I;
       create policy owner_all on %I for all
         using (user_id = auth.uid()) with check (user_id = auth.uid())', t, t);
  end loop;
end $$;
