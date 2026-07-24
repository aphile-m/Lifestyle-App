/* score.js — Lifestyle Score engine (SPEC.md §3).
   0–100 aggregate from five pillar sub-scores; behaviour-heavy by design.
   Weights are the weight-loss profile and are user-visible, never hidden. */

import { logs } from './store.js';

export const WEIGHTS = {
  move:        { label: 'Move',        weight: 0.25 },
  fuel:        { label: 'Fuel',        weight: 0.30 },
  recover:     { label: 'Recover',     weight: 0.20 },
  consistency: { label: 'Consistency', weight: 0.15 },
  body:        { label: 'Body',        weight: 0.10 },
};

/* Weekly score over the trailing 7 days. Each pillar returns 0–100 or null
   (null = not enough data yet; pillar is excluded and weights renormalise,
   so missing sensors never read as "failing"). */
export async function weeklyScore() {
  const [workouts, foods, checkins35, journal, weights, metrics] = await Promise.all([
    logs.recent('workouts', 7), logs.recent('foods', 7),
    logs.recent('checkins', 35), logs.recent('journal', 7),
    logs.recent('weights', 28), logs.recent('metrics', 7),
  ]);
  const cutoff = Date.now() - 7 * 86400e3;
  const checkins = checkins35.filter(c => Date.parse(c.ts) >= cutoff);
  const priorCheckins = checkins35.filter(c => Date.parse(c.ts) < cutoff);

  const pillars = {
    move: pillarMove(workouts, metrics),
    fuel: pillarFuel(foods, checkins, priorCheckins),
    recover: pillarRecover(checkins, metrics),
    consistency: pillarConsistency([workouts, foods, checkins, journal]),
    body: pillarBody(weights),
  };

  let total = 0, weightSum = 0;
  for (const [key, val] of Object.entries(pillars)) {
    if (val === null) continue;
    total += val * WEIGHTS[key].weight;
    weightSum += WEIGHTS[key].weight;
  }
  const aggregate = weightSum ? Math.round(total / weightSum) : null;
  return { aggregate, pillars };
}

/* --- pillar heuristics (v0: simple, honest; refined as data sources land) --- */

const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;

/* MOVE — anchored to WHO physical-activity guidelines:
   150 min/wk moderate aerobic + 2 strength sessions/wk; steps target 8k/day
   (mortality benefit plateaus ~7.5–8.5k, Paluch 2022 meta-analysis). */
function pillarMove(workouts, metrics = []) {
  if (!workouts.length && !metrics.some(m => m.steps != null)) return null;
  const parts = [];
  const isStrength = w => /strength|weight|gym|lift|resistance|dumbbell/i.test(w.desc || '') ||
    (w.detail?.type || '').includes('strength');
  const strength = workouts.filter(isStrength).length;
  const cardioMin = workouts.filter(w => !isStrength(w))
    .reduce((a, w) => a + (w.detail?.moving_time_s ? w.detail.moving_time_s / 60 : 40), 0);
  if (workouts.length) {
    parts.push(clamp(strength / 2 * 100));          // WHO: 2 strength sessions
    parts.push(clamp(cardioMin / 150 * 100));       // WHO: 150 moderate minutes
  }
  const steps = metrics.map(m => m.steps).filter(v => v != null);
  if (steps.length) parts.push(clamp(mean(steps) / 8000 * 100));
  return clamp(Math.round(mean(parts)));
}

/* FUEL — logging consistency (self-monitoring is the strongest predictor of
   weight-loss success, Burke 2011), home-cooked ratio, hydration vs the EFSA
   ~2 L/day (≈8 glasses), and alcohol with HARM-REDUCTION credit: absolute
   score follows the UK CMO low-risk guideline (≤14 units/wk), but improving
   on your own 4-week baseline scores well even before you're under it. */
function pillarFuel(foods, checkins = [], priorCheckins = []) {
  if (!foods.length && !checkins.length) return null;
  const parts = [];
  if (foods.length) {
    const daysLogged = new Set(foods.map(f => f.ts.slice(0, 10))).size;
    const homeCooked = foods.filter(f => f.source === 'cookbook').length / foods.length;
    parts.push(clamp(daysLogged / 7 * 100));
    parts.push(clamp(homeCooked * 100));
  }
  const water = checkins.map(c => c.water).filter(v => v != null);
  if (water.length) parts.push(clamp(mean(water) / 8 * 100));
  const drinkDays = checkins.filter(c => c.drinks != null);
  if (drinkDays.length) {
    const week = drinkDays.reduce((a, c) => a + c.drinks, 0);
    const absolute = week <= 2 ? 100 : week <= 7 ? 90 : week <= 14 ? 70 : clamp(70 - (week - 14) * 6);
    const priorDays = priorCheckins.filter(c => c.drinks != null);
    let alcohol = absolute;
    if (priorDays.length >= 3) {
      const priorWeekly = priorDays.reduce((a, c) => a + c.drinks, 0) / priorDays.length * 7;
      if (priorWeekly > 0) {
        const improvement = Math.max(0, Math.min(1, (priorWeekly - week) / priorWeekly));
        alcohol = Math.max(absolute, Math.round(60 + 40 * improvement)); // cutting 5 → 1 scores ~92
      }
    }
    parts.push(clamp(alcohol));
  }
  return parts.length ? clamp(Math.round(mean(parts))) : null;
}

/* RECOVER — Garmin sleep score targets the 7–9 h consensus range (National
   Sleep Foundation); Body Battery and self-reported sleep/energy fill gaps. */
function pillarRecover(checkins, metrics = []) {
  if (!checkins.length && !metrics.length) return null;
  const parts = [];
  if (checkins.length) {
    const sleep = mean(checkins.map(c => c.sleep ?? 3));
    const energy = mean(checkins.map(c => c.energy ?? 3));
    parts.push(((sleep + energy) / 2 - 1) / 4 * 100);
  }
  // Garmin day logs (sleep score + Body Battery are already 0–100 scales)
  const garmin = metrics.flatMap(m => [m.sleepScore, m.bodyBattery]).filter(v => v != null);
  if (garmin.length) parts.push(mean(garmin));
  return clamp(Math.round(mean(parts)));
}

function pillarConsistency(streams) {
  const daysActive = new Set(streams.flat().map(r => r.ts.slice(0, 10))).size;
  if (!daysActive) return null;
  return clamp(Math.round((daysActive / 7) * 100));
}

function pillarBody(weights) {
  if (weights.length < 4) return null; // need a trend, not a spike
  // Trend = 7-day EMA slope vs sustainable band (−0.25 to −0.75 kg/week)
  const sorted = [...weights].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const ema = [];
  const k = 2 / 8;
  for (const w of sorted) ema.push(ema.length ? w.kg * k + ema[ema.length - 1] * (1 - k) : w.kg);
  const spanDays = (Date.parse(sorted[sorted.length - 1].ts) - Date.parse(sorted[0].ts)) / 86400e3 || 1;
  const perWeek = (ema[ema.length - 1] - ema[0]) / spanDays * 7;
  if (perWeek <= -0.25 && perWeek >= -0.75) return 100;        // in the sustainable band
  if (perWeek < -0.75) return 60;                              // too fast — not sustainable
  if (perWeek < 0) return 80;                                  // losing, gently
  return clamp(Math.round(60 - perWeek * 40));                 // flat/up: slope-dependent
}

export function trendWeight(weights) {
  if (!weights.length) return null;
  const sorted = [...weights].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const k = 2 / 8;
  return sorted.reduce((ema, w) => ema === null ? w.kg : w.kg * k + ema * (1 - k), null);
}

const clamp = n => Math.max(0, Math.min(100, n));
