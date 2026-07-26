/* store.js — settings (localStorage) + logs (IndexedDB), local-first.
   Supabase sync rides on top of this later (see SPEC.md §9). */

const SETTINGS_KEY = 'trainer_settings';

export const settings = {
  load() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
  },
  save(patch) {
    const next = { ...settings.load(), ...patch };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    return next;
  },
  get apiKey() { return (settings.load().apiKey || '').trim(); },
  get profile() { return settings.load().profile || defaultProfile(); },
};

export function defaultProfile() {
  return {
    name: 'Aphile',
    goal: 'Weight loss through sustainable lifestyle changes',
    targetRate: '0.25–0.75 kg/week',
    watch: 'Garmin Vivoactive 4',
    tone: 'balanced', // gentle ↔ direct dial; Vic's core persona is constant
    injuries: '',
    equipment: 'dumbbells, bench, Swiss ball, stepper, skipping rope, resistance bands, ankle weights, walker/treadmill',
    modalities: 'street running, bodyweight workouts',
    sessionMinutes: 60, // includes warm-up and cool-down (SPEC §2.2)
    baselineStart: null, // ISO date the calibration fortnight began
    // biology for energy/protein targets (Mifflin-St Jeor needs all three)
    age: null,
    sex: null, // 'male' | 'female'
    heightCm: null,
  };
}

/* ---------- IndexedDB ---------- */
const DB_NAME = 'trainer';
const DB_VER = 3;
// One store per log type; all rows: { id, ts (ISO), ...payload }
const STORES = ['weights', 'foods', 'workouts', 'journal', 'checkins', 'scores', 'chat',
  'measurements', 'benchmarks', 'plans', 'metrics', 'mealplans'];

let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      for (const name of STORES) {
        if (!req.result.objectStoreNames.contains(name)) {
          const os = req.result.createObjectStore(name, { keyPath: 'id', autoIncrement: true });
          os.createIndex('ts', 'ts');
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const res = fn(t.objectStore(store));
    t.oncomplete = () => resolve(res && res.result !== undefined ? res.result : res);
    t.onerror = () => reject(t.error);
  }));
}

export const logs = {
  add(store, payload) {
    return tx(store, 'readwrite', os => os.add({ ts: new Date().toISOString(), ...payload }));
  },
  put(store, row) { // update an existing row (must include its id)
    return tx(store, 'readwrite', os => os.put(row));
  },
  all(store) {
    return tx(store, 'readonly', os => os.getAll()).then(r => r || []);
  },
  /* rows with ts within the last n days */
  async recent(store, days) {
    const cutoff = Date.now() - days * 86400e3;
    return (await logs.all(store)).filter(r => Date.parse(r.ts) >= cutoff);
  },
};
