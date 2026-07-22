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
  const [workouts, foods, checkins, journal, weights] = await Promise.all([
    logs.recent('workouts', 7), logs.recent('foods', 7),
    logs.recent('checkins', 7), logs.recent('journal', 7),
    logs.recent('weights', 28),
  ]);

  const pillars = {
    move: pillarMove(workouts),
    fuel: pillarFuel(foods),
    recover: pillarRecover(checkins),
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

function pillarMove(workouts) {
  if (!workouts.length) return null;
  // v0: 4 sessions/week ≈ full marks
  return clamp(Math.round((workouts.length / 4) * 100));
}

function pillarFuel(foods) {
  if (!foods.length) return null;
  // v0: rewards logging consistency (≈3 meals/day) + home-cooked ratio
  const daysLogged = new Set(foods.map(f => f.ts.slice(0, 10))).size;
  const homeCooked = foods.filter(f => f.source === 'cookbook').length / foods.length;
  return clamp(Math.round((daysLogged / 7) * 70 + homeCooked * 30));
}

function pillarRecover(checkins) {
  if (!checkins.length) return null;
  // v0: mean of self-reported sleep + energy (1–5 scales) until Health Connect lands
  const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const sleep = mean(checkins.map(c => c.sleep ?? 3));
  const energy = mean(checkins.map(c => c.energy ?? 3));
  return clamp(Math.round(((sleep + energy) / 2 - 1) / 4 * 100));
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
