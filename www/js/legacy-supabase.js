/* legacy-supabase.js — read-only Supabase client, kept for ONE job: moving the
   old data into OneDrive.

   Deliberately separate from sync.js so the migration is repeatable and
   verifiable. The tempting shortcut — "this device's IndexedDB already has
   everything, just push it" — is only true if this device ever saw every row.
   Pulling from the source of record instead means the migration can be run
   again, and checked.

   Nothing here writes to Supabase. Delete this file once the move is done.
*/

import { logs } from './store.js';

const URL_ = 'https://uaqvqvrflzxulixdrmna.supabase.co';
const KEY = 'sb_publishable_o1xfAQwaiVwuPkZOWgZfFw_2AsUlCOz';

/* The old tables, paired with the local store they feed and the mapper that
   was used to read them. Copied from the pre-migration sync.js so the import
   is faithful even after those mappers change shape. */
const LEGACY = [
  ['weights', 'trainer_weights', 'ts', t => ({ ts: t.ts, kg: Number(t.kg) })],
  ['foods', 'trainer_food_logs', 'ts', t => ({ ts: t.ts, desc: t.description, source: t.source, kcal: t.kcal, protein: t.protein_g, carbs: t.carbs_g, fat: t.fat_g, recipeId: t.recipe_id })],
  ['workouts', 'trainer_workouts', 'ts', t => ({ ts: t.ts, desc: t.description, rpe: t.rpe, planned: t.planned, detail: t.detail, stravaId: t.strava_id })],
  ['checkins', 'trainer_checkins', 'day', t => ({ ts: t.day + 'T12:00:00.000Z', sleep: t.sleep_1_5, energy: t.energy_1_5, water: t.water_glasses, drinks: t.drinks != null ? Number(t.drinks) : null, drinksDetail: t.drinks_detail, coffee: t.caffeine_cups, supps: t.supplements })],
  ['measurements', 'trainer_measurements', 'ts', t => ({ ts: t.ts, waist: t.waist_cm && +t.waist_cm, hips: t.hips_cm && +t.hips_cm, chest: t.chest_cm && +t.chest_cm, arm: t.arm_cm && +t.arm_cm, thigh: t.thigh_cm && +t.thigh_cm })],
  ['benchmarks', 'trainer_benchmarks', 'ts', t => ({ ts: t.ts, restingHr: t.resting_hr, runSec: t.run_1600m_sec, pushups: t.pushups_max, plankSec: t.plank_sec, squatReps: t.goblet_squat_reps, squatKg: t.goblet_squat_kg && +t.goblet_squat_kg })],
  ['metrics', 'trainer_daily_metrics', 'day', t => ({ ts: t.day + 'T12:00:00.000Z', sleepScore: t.sleep_score, restingHr: t.resting_hr, stress: t.stress_avg, bodyBattery: t.body_battery_high, steps: t.steps, sleepHours: t.sleep_hours != null ? Number(t.sleep_hours) : null })],
  ['chat', 'trainer_chat', 'ts', t => ({ ts: t.ts, role: t.role, text: t.text, actions: t.actions })],
  ['plans', 'trainer_plans', 'created_at', t => ({ ts: t.created_at, active: t.active, plan: t.plan })],
];

async function legacyToken(email, password) {
  const res = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: KEY },
    body: JSON.stringify({ email, password }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error_description || d.msg || `Supabase sign-in failed (${res.status})`);
  return d.access_token;
}

async function get(token, table, query) {
  const res = await fetch(`${URL_}/rest/v1/${table}?${query}`, {
    headers: { apikey: KEY, authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`${table}: read failed (${res.status})`);
  return res.json();
}

/* Pull everything into IndexedDB as UNSYNCED, so the normal pushAll() is what
   actually writes it to OneDrive — one code path doing the writing, already
   tested. Rows already present locally (matched on their key) are skipped, so
   running this twice doesn't duplicate anything. */
export async function importFromSupabase(email, password, onProgress = () => {}) {
  const token = await legacyToken(email, password);
  const counts = {};
  for (const [store, table, order, down] of LEGACY) {
    onProgress(`Reading ${table}…`);
    const rows = await get(token, table, `select=*&order=${order}`);
    const seen = new Set((await logs.all(store)).map(r => r.ts));
    let added = 0;
    for (const t of rows) {
      const local = down(t);
      if (seen.has(local.ts)) continue;
      await logs.add(store, { ...local, synced: false });
      added++;
    }
    counts[store] = added;
  }
  // journal was one row per (day, tag); reassemble it into the app's shape
  onProgress('Reading trainer_journal_tags…');
  const tags = await get(token, 'trainer_journal_tags', 'select=*&order=day');
  const byDay = {};
  for (const t of tags) (byDay[t.day] ||= []).push(t.tag);
  const seenJ = new Set((await logs.all('journal')).map(r => r.ts));
  let j = 0;
  for (const [d, list] of Object.entries(byDay)) {
    const ts = d + 'T20:00:00.000Z';
    if (seenJ.has(ts)) continue;
    await logs.add('journal', { ts, tags: list, synced: false });
    j++;
  }
  counts.journal = j;

  onProgress('Reading trainer_profile…');
  const prof = await get(token, 'trainer_profile', 'select=profile');
  return { counts, profile: prof[0]?.profile || null };
}
