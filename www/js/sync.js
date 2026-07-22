/* sync.js — Supabase cloud sync (SPEC §9), no SDK: GoTrue auth + PostgREST via fetch.
   Local-first: IndexedDB is truth on this device; unsynced rows are pushed and marked
   with a `synced` flag. Config (url/anon key) ships in settings so it can be filled
   once the host project is chosen. */

import { settings, logs } from './store.js';

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
async function authFetch(path, body) {
  const { url, anonKey } = syncConfig();
  const res = await fetch(`${url}/auth/v1/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: anonKey },
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
  return res.status === 204 ? null : res.json();
}

/* ---------- mappers: IndexedDB store -> table rows ---------- */
const day = ts => ts.slice(0, 10);
const MAP = {
  weights:      r => ['trainer_weights', { ts: r.ts, kg: r.kg }],
  foods:        r => ['trainer_food_logs', { ts: r.ts, description: r.desc, source: r.source || 'manual' }],
  workouts:     r => ['trainer_workouts', { ts: r.ts, description: r.desc, rpe: r.rpe ?? null, planned: !!r.planned, detail: r.detail || {} }],
  checkins:     r => ['trainer_checkins?on_conflict=user_id,day', { day: day(r.ts), sleep_1_5: r.sleep ?? null, energy_1_5: r.energy ?? null }],
  measurements: r => ['trainer_measurements', { ts: r.ts, waist_cm: r.waist ?? null, hips_cm: r.hips ?? null, chest_cm: r.chest ?? null, arm_cm: r.arm ?? null, thigh_cm: r.thigh ?? null }],
  benchmarks:   r => ['trainer_benchmarks', { ts: r.ts, resting_hr: r.restingHr ?? null, run_1600m_sec: r.runSec ?? null, pushups_max: r.pushups ?? null, plank_sec: r.plankSec ?? null, goblet_squat_reps: r.squatReps ?? null, goblet_squat_kg: r.squatKg ?? null }],
  plans:        r => ['trainer_plans', { created_at: r.ts, active: !!r.active, month_theme: r.plan?.month_theme || null, start_date: r.plan?.start_date || null, plan: r.plan }],
};

/* journal rows expand to one table row per tag */
function journalRows(r) {
  return (r.tags || []).map(tag => ({ day: day(r.ts), tag, auto: false }));
}

/* Push everything unsynced. Returns counts per store. */
export async function pushAll() {
  if (!syncReady() || !signedIn()) throw new Error('NOT_SIGNED_IN');
  const counts = {};
  for (const [store, map] of Object.entries(MAP)) {
    const rows = (await logs.all(store)).filter(r => !r.synced);
    if (rows.length) {
      // group by target (checkins carry an on_conflict query)
      const [table] = map(rows[0]);
      await rest('POST', table, rows.map(r => map(r)[1]));
      for (const r of rows) await logs.put(store, { ...r, synced: true });
    }
    counts[store] = rows.length;
  }
  const jrows = (await logs.all('journal')).filter(r => !r.synced);
  const expanded = jrows.flatMap(journalRows);
  if (expanded.length) {
    await rest('POST', 'trainer_journal_tags?on_conflict=user_id,day,tag', expanded);
    for (const r of jrows) await logs.put('journal', { ...r, synced: true });
  }
  counts.journal = jrows.length;
  settings.save({ lastSync: new Date().toISOString() });
  return counts;
}

/* Also mirror profile */
export async function pushProfile() {
  if (!syncReady() || !signedIn()) return;
  await rest('POST', 'trainer_profile?on_conflict=user_id',
    [{ profile: settings.profile, updated_at: new Date().toISOString() }]);
}
