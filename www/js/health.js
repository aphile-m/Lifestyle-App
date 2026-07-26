/* health.js — Health Connect auto-sync (Android shell only, SPEC §5.3).
   Garmin Connect mirrors the watch's wellness data into Android Health Connect;
   this module pulls steps, sleep and resting heart rate from there into the
   daily metrics store every launch. Manual entries always win — Health Connect
   only fills fields that are empty. Sleep score / Body Battery stay manual
   (Garmin keeps its proprietary numbers out of Health Connect). */

import { settings, logs } from './store.js';

const plugin = () =>
  (window.Capacitor?.isNativePlatform?.() && window.Capacitor.Plugins?.Health) || null;

export const hcSupported = () => !!plugin();
export const hcConnected = () => !!settings.load().healthConnect;
export const hcLastSync = () => settings.load().healthLastSync || null;

export async function hcConnect() {
  const hc = plugin();
  if (!hc) throw new Error('Health Connect works in the Android app only.');
  const avail = await hc.isAvailable();
  if (!avail.available) {
    await hc.openHealthConnectSettings().catch(() => {});
    throw new Error('Health Connect is not available — install/enable it, then try again.');
  }
  await hc.requestAuthorization({ read: ['steps', 'sleep', 'restingHeartRate'], write: [] });
  const status = await hc.checkAuthorization({ read: ['steps', 'sleep', 'restingHeartRate'] });
  settings.save({ healthConnect: true, healthAuth: status });
  return status;
}

const dayOf = iso => iso.slice(0, 10);

/* Pull the last `days` days and merge per-day into the metrics store. */
export async function hcSync(days = 7) {
  const hc = plugin();
  if (!hc || !hcConnected()) return null;
  const end = new Date();
  const start = new Date(Date.now() - days * 86400e3);
  const range = { startDate: start.toISOString(), endDate: end.toISOString() };

  const perDay = {}; // iso day -> {steps, restingHr, sleepHours}
  const touch = d => (perDay[d] ||= {});

  try {
    const agg = await hc.queryAggregated({ dataType: 'steps', ...range, bucket: 'day', aggregation: 'sum' });
    for (const b of agg.aggregatedData || agg.samples || []) {
      if (b.value > 0) touch(dayOf(b.startDate)).steps = Math.round(b.value);
    }
  } catch {}
  try {
    const agg = await hc.queryAggregated({ dataType: 'restingHeartRate', ...range, bucket: 'day', aggregation: 'average' });
    for (const b of agg.aggregatedData || agg.samples || []) {
      if (b.value > 0) touch(dayOf(b.startDate)).restingHr = Math.round(b.value);
    }
  } catch {}
  try {
    const res = await hc.readSamples({ dataType: 'sleep', ...range, limit: 100, ascending: true });
    for (const s of res.samples || []) {
      // a night belongs to the day you wake up; prefer stage data, else duration
      const day = dayOf(s.endDate);
      let mins;
      if (s.stages?.length) {
        mins = s.stages.filter(st => st.sleepState !== 'awake' && st.sleepState !== 'inBed')
          .reduce((a, st) => a + (Date.parse(st.endDate) - Date.parse(st.startDate)) / 60000, 0);
      } else if (s.unit === 'minute') {
        mins = s.value;
      } else {
        mins = (Date.parse(s.endDate) - Date.parse(s.startDate)) / 60000;
      }
      if (mins > 0) touch(day).sleepHours = Math.round(((touch(day).sleepHours || 0) + mins / 60) * 10) / 10;
    }
  } catch {}

  // merge into the metrics store: Health Connect fills gaps, never overwrites
  const existing = await logs.all('metrics');
  const byDay = {};
  existing.forEach(r => { byDay[dayOf(r.ts)] = r; });
  let updated = 0;
  for (const [day, vals] of Object.entries(perDay)) {
    if (!Object.keys(vals).length) continue;
    const row = byDay[day];
    if (row) {
      const patch = {};
      for (const [k, v] of Object.entries(vals)) if (row[k] == null) patch[k] = v;
      if (Object.keys(patch).length) { await logs.put('metrics', { ...row, ...patch, synced: false }); updated++; }
    } else {
      await logs.add('metrics', { ts: day + 'T12:00:00.000Z', ...vals });
      updated++;
    }
  }
  settings.save({ healthLastSync: new Date().toISOString() });
  return { days: Object.keys(perDay).length, updated };
}
