/* sync.js — Supabase cloud sync (SPEC §9), no SDK: GoTrue auth + PostgREST via fetch.
   Local-first: IndexedDB is truth on this device; unsynced rows are pushed and marked
   with a `synced` flag. pullAll() rehydrates an empty fresh device from the cloud. */

import { settings, logs, defaultProfile } from './store.js';

/* Shared project defaults (host: "Vinyl Database" project, decided 2026-07-22).
   The publishable key is safe to ship client-side — RLS guards every row. */
const DEFAULT_URL = 'https://uaqvqvrflzxulixdrmna.supabase.co';
const DEFAULT_KEY = 'sb_publishable_o1xfAQwaiVwuPkZOWgZfFw_2AsUlCOz';

export function syncConfig() {
  const s = settings.load();
  return {
    url: (s.supabaseUrl || DEFAULT_URL).replace(/\/$/, ''),
    anonKey: s.supabaseAnonKey || DEFAULT_KEY,
    session: s.supabaseSession || null, // {access_token, refresh_token, expires_at, user_id}
  };
}
export const syncReady = () => { const c = syncConfig(); return !!(c.url && c.anonKey); };
export const signedIn = () => !!syncConfig().session;

/* ---------- auth (email + password) ---------- */
async function authFetch(path, body, bearer) {
  const { url, anonKey } = syncConfig();
  const res = await fetch(`${url}/auth/v1/${path}`, {
    method: bearer ? 'PUT' : 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: anonKey,
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.msg || data.error_description || data.message || `Auth failed (${res.status})`);
  return data;
}

export async function signUp(email, password) {
  const d = await authFetch('signup', { email, password });
  if (d.access_token) saveSession(d);
  return d;
}
export async function signIn(email, password) {
  const d = await authFetch('token?grant_type=password', { email, password });
  saveSession(d);
  return d;
}
export async function changePassword(newPassword) {
  await authFetch('user', { password: newPassword }, await token());
}
function saveSession(d) {
  settings.save({
    supabaseSession: {
      access_token: d.access_token,
      refresh_token: d.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + (d.expires_in || 3600),
      user_id: d.user?.id,
    },
  });
}
/* Exported: always returns a FRESH access token (auto-refreshes near expiry). */
export async function accessToken() { return token(); }

async function token() {
  let { session } = syncConfig();
  if (!session) throw new Error('NOT_SIGNED_IN');
  if (session.expires_at - 60 < Date.now() / 1000) {
    const d = await authFetch('token?grant_type=refresh_token', { refresh_token: session.refresh_token });
    saveSession(d);
    session = syncConfig().session;
  }
  return session.access_token;
}

/* ---------- REST ---------- */
async function rest(method, table, body, query = '') {
  const { url, anonKey } = syncConfig();
  const res = await fetch(`${url}/rest/v1/${table}${query}`, {
    method,
    headers: {
      'content-type': 'application/json',
      apikey: anonKey,
      authorization: `Bearer ${await token()}`,
      prefer: method === 'POST' ? 'resolution=merge-duplicates,return=minimal' : 'return=minimal',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${table}: sync failed (${res.status}) ${(await res.text()).slice(0, 120)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null; // return=minimal answers 201 with an EMPTY body
}

export async function restGet(table, query = '') {
  const { url, anonKey } = syncConfig();
  const res = await fetch(`${url}/rest/v1/${table}?${query}`, {
    headers: { apikey: anonKey, authorization: `Bearer ${await token()}` },
  });
  if (!res.ok) throw new Error(`${table}: fetch failed (${res.status})`);
  return res.json();
}
export const restUpsert = (table, rows, onConflict) =>
  rest('POST', table + (onConflict ? `?on_conflict=${onConflict}` : ''), rows);
export const restPatch = (table, query, patch) => rest('PATCH', table, patch, `?${query}`);

/* ---------- mappers: IndexedDB store <-> table rows ---------- */
const day = ts => ts.slice(0, 10);
const MAP = {
  weights: {
    table: 'trainer_weights',
    up: r => ({ ts: r.ts, kg: r.kg }),
    down: t => ({ ts: t.ts, kg: Number(t.kg) }),
  },
  foods: {
    table: 'trainer_food_logs',
    up: r => ({ ts: r.ts, description: r.desc, source: r.source || 'manual', kcal: r.kcal ?? null, protein_g: r.protein ?? null, carbs_g: r.carbs ?? null, fat_g: r.fat ?? null, recipe_id: r.recipeId ?? null, servings: r.servings ?? 1 }),
    down: t => ({ ts: t.ts, desc: t.description, source: t.source, kcal: t.kcal, protein: t.protein_g, carbs: t.carbs_g, fat: t.fat_g, recipeId: t.recipe_id }),
  },
  workouts: {
    table: 'trainer_workouts',
    up: r => ({ ts: r.ts, description: r.desc, rpe: r.rpe ?? null, planned: !!r.planned, detail: r.detail || {}, strava_id: r.stravaId ?? null }),
    down: t => ({ ts: t.ts, desc: t.description, rpe: t.rpe, planned: t.planned, detail: t.detail, stravaId: t.strava_id }),
  },
  checkins: {
    table: 'trainer_checkins', conflict: 'user_id,day', orderBy: 'day',
    up: r => ({ day: day(r.ts), sleep_1_5: r.sleep ?? null, energy_1_5: r.energy ?? null, water_glasses: r.water ?? null, drinks: r.drinks ?? null, drinks_detail: r.drinksDetail ?? null, caffeine_cups: r.coffee ?? null }),
    down: t => ({ ts: t.day + 'T12:00:00.000Z', sleep: t.sleep_1_5, energy: t.energy_1_5, water: t.water_glasses, drinks: t.drinks != null ? Number(t.drinks) : t.drinks, drinksDetail: t.drinks_detail, coffee: t.caffeine_cups }),
  },
  measurements: {
    table: 'trainer_measurements', conflict: 'user_id,ts', // rows are editable in place
    up: r => ({ ts: r.ts, waist_cm: r.waist ?? null, hips_cm: r.hips ?? null, chest_cm: r.chest ?? null, arm_cm: r.arm ?? null, thigh_cm: r.thigh ?? null }),
    down: t => ({ ts: t.ts, waist: t.waist_cm && +t.waist_cm, hips: t.hips_cm && +t.hips_cm, chest: t.chest_cm && +t.chest_cm, arm: t.arm_cm && +t.arm_cm, thigh: t.thigh_cm && +t.thigh_cm }),
  },
  benchmarks: {
    table: 'trainer_benchmarks', conflict: 'user_id,ts', // rows are editable in place
    up: r => ({ ts: r.ts, resting_hr: r.restingHr ?? null, run_1600m_sec: r.runSec ?? null, pushups_max: r.pushups ?? null, plank_sec: r.plankSec ?? null, goblet_squat_reps: r.squatReps ?? null, goblet_squat_kg: r.squatKg ?? null }),
    down: t => ({ ts: t.ts, restingHr: t.resting_hr, runSec: t.run_1600m_sec, pushups: t.pushups_max, plankSec: t.plank_sec, squatReps: t.goblet_squat_reps, squatKg: t.goblet_squat_kg && +t.goblet_squat_kg }),
  },
  metrics: {
    table: 'trainer_daily_metrics', conflict: 'user_id,day', orderBy: 'day',
    up: r => ({ day: day(r.ts), sleep_score: r.sleepScore ?? null, resting_hr: r.restingHr ?? null, stress_avg: r.stress ?? null, body_battery_high: r.bodyBattery ?? null, steps: r.steps ?? null }),
    down: t => ({ ts: t.day + 'T12:00:00.000Z', sleepScore: t.sleep_score, restingHr: t.resting_hr, stress: t.stress_avg, bodyBattery: t.body_battery_high, steps: t.steps }),
  },
  plans: {
    table: 'trainer_plans', orderBy: 'created_at',
    up: r => ({ created_at: r.ts, active: !!r.active, month_theme: r.plan?.month_theme || null, start_date: r.plan?.start_date || null, plan: r.plan }),
    down: t => ({ ts: t.created_at, active: t.active, plan: t.plan }),
  },
};

function journalRows(r) {
  return (r.tags || []).map(tag => ({ day: day(r.ts), tag, auto: false }));
}

/* Push everything unsynced. Fault-tolerant: one failing table no longer blocks
   the rest — failures are collected and reported. Returns counts per store. */
export async function pushAll() {
  if (!syncReady() || !signedIn()) throw new Error('NOT_SIGNED_IN');
  const counts = {};
  const errors = [];
  for (const [store, m] of Object.entries(MAP)) {
    try {
      const rows = (await logs.all(store)).filter(r => !r.synced);
      if (rows.length) {
        await rest('POST', m.table + (m.conflict ? `?on_conflict=${m.conflict}` : ''), rows.map(m.up));
        for (const r of rows) await logs.put(store, { ...r, synced: true });
      }
      counts[store] = rows.length;
    } catch (e) {
      counts[store] = 0;
      errors.push(`${store}: ${e.message}`);
    }
  }
  try {
    const jrows = (await logs.all('journal')).filter(r => !r.synced);
    const expanded = jrows.flatMap(journalRows);
    if (expanded.length) await rest('POST', 'trainer_journal_tags?on_conflict=user_id,day,tag', expanded);
    for (const r of jrows) await logs.put('journal', { ...r, synced: true });
    counts.journal = jrows.length;
  } catch (e) {
    counts.journal = 0;
    errors.push('journal: ' + e.message);
  }
  settings.save({ lastSync: new Date().toISOString() });
  if (errors.length) {
    const err = new Error('Partial sync — ' + errors.join(' • '));
    err.counts = counts;
    throw err;
  }
  return counts;
}

/* Pull-restore: for every EMPTY local store, rehydrate from the cloud (fresh device).
   Non-empty stores are left alone — local is truth on this device. */
export async function pullAll() {
  if (!syncReady() || !signedIn()) throw new Error('NOT_SIGNED_IN');
  const counts = {};
  for (const [store, m] of Object.entries(MAP)) {
    const local = await logs.all(store);
    if (local.length) { counts[store] = 0; continue; }
    const remote = await restGet(m.table, 'select=*&order=' + (m.orderBy || 'ts'));
    for (const t of remote) await logs.add(store, { ...m.down(t), synced: true });
    counts[store] = remote.length;
  }
  if (!(await logs.all('journal')).length) {
    const tags = await restGet('trainer_journal_tags', 'select=*&order=day');
    const byDay = {};
    for (const t of tags) (byDay[t.day] ||= []).push(t.tag);
    for (const [d, list] of Object.entries(byDay)) {
      await logs.add('journal', { ts: d + 'T20:00:00.000Z', tags: list, synced: true });
    }
    counts.journal = tags.length;
  }
  await adoptCloudSetup();
  return counts;
}

/* Adopt the cloud profile AND device setup (API key, Strava credentials) into
   local settings — anything missing locally is filled from the cloud, so a new
   device needs nothing but a sign-in. */
export async function adoptCloudSetup() {
  const rows = await restGet('trainer_profile', 'select=profile');
  const p = rows[0]?.profile;
  if (!p) return false;
  const { _setup, ...profile } = p;
  const s = settings.load();
  const patch = {};
  if (!s.profileConfirmed && Object.keys(profile).length) {
    patch.profile = { ...defaultProfile(), ...s.profile, ...profile };
    patch.profileConfirmed = true;
  }
  if (_setup) {
    if (!s.apiKey && _setup.apiKey) patch.apiKey = _setup.apiKey;
    if (!s.stravaClientId && _setup.stravaClientId) patch.stravaClientId = _setup.stravaClientId;
    if (!s.stravaClientSecret && _setup.stravaClientSecret) patch.stravaClientSecret = _setup.stravaClientSecret;
    if (!s.stravaTokens && _setup.stravaTokens) patch.stravaTokens = _setup.stravaTokens;
  }
  if (Object.keys(patch).length) settings.save(patch);
  return true;
}

/* Mirror the profile PLUS device setup (API key, Strava credentials) so any
   device restores completely after one sign-in. Rows are protected by RLS in
   your own Supabase project. */
export async function pushProfile() {
  if (!syncReady() || !signedIn()) return;
  const s = settings.load();
  const payload = {
    ...settings.profile,
    _setup: {
      apiKey: s.apiKey || null,
      stravaClientId: s.stravaClientId || null,
      stravaClientSecret: s.stravaClientSecret || null,
      stravaTokens: s.stravaTokens || null,
    },
  };
  await rest('POST', 'trainer_profile?on_conflict=user_id',
    [{ profile: payload, updated_at: new Date().toISOString() }]);
}
