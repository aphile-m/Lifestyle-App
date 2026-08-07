/* score.js — Lifestyle Score engine (SPEC.md §3).
   0–100 aggregate from five pillar sub-scores; behaviour-heavy by design.
   Weights are the weight-loss profile and are user-visible, never hidden.
   Every pillar returns {score, drivers} — the same numbers power the Today
   card (score only) and the Insights screen (drivers, gaps, tips). */

import { logs, settings } from './store.js';

/* Personal energy & protein targets — transparent, standard sports-science:
   BMR via Mifflin-St Jeor, activity factor from measured steps + training
   frequency, intake target = TDEE − 500 kcal (≈0.5 kg/wk, mid of the
   0.25–0.75 band), protein 1.6 g/kg for muscle retention in a deficit. */
export function energyTargets(profile, weightKg, { stepsAvg = null, workoutsPerWeek = 0 } = {}) {
  const { age, sex, heightCm } = profile || {};
  if (!age || !sex || !heightCm || !weightKg) return null;
  const bmr = Math.round(10 * weightKg + 6.25 * heightCm - 5 * age + (sex === 'male' ? 5 : -161));
  let factor = 1.35; // baseline daily living
  if (stepsAvg != null) factor += stepsAvg >= 8000 ? 0.1 : stepsAvg >= 5000 ? 0.05 : 0;
  factor += workoutsPerWeek >= 3 ? 0.1 : workoutsPerWeek >= 1 ? 0.05 : 0;
  const tdee = Math.round(bmr * Math.min(1.6, factor));
  return {
    bmr, tdee, factor: Math.min(1.6, factor),
    target: tdee - 500,                    // sustainable-deficit midpoint
    band: [tdee - 825, tdee - 275],        // 0.25–0.75 kg/wk equivalents
    proteinG: Math.round(weightKg * 1.6),
  };
}

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
  const { aggregate, pillars } = await scoreDetail();
  return { aggregate, pillars };
}

/* Full breakdown: aggregate + per-pillar scores AND the drivers behind them.
   A driver: {label, value (display string), score 0-100|null, tip}. */
export async function scoreDetail() {
  const [workouts, foods, checkins35, journal, weights, metrics] = await Promise.all([
    logs.recent('workouts', 7), logs.recent('foods', 7),
    logs.recent('checkins', 35), logs.recent('journal', 7),
    logs.recent('weights', 28), logs.recent('metrics', 7),
  ]);
  const cutoff = Date.now() - 7 * 86400e3;
  const checkins = checkins35.filter(c => Date.parse(c.ts) >= cutoff);
  const priorCheckins = checkins35.filter(c => Date.parse(c.ts) < cutoff);

  const detail = {
    move: pillarMove(workouts, metrics),
    fuel: pillarFuel(foods, checkins, priorCheckins, { workouts, metrics, weights }),
    recover: pillarRecover(checkins, metrics),
    consistency: pillarConsistency([workouts, foods, checkins, journal], checkins),
    body: pillarBody(weights),
  };
  const pillars = Object.fromEntries(Object.entries(detail).map(([k, d]) => [k, d.score]));

  let total = 0, weightSum = 0;
  for (const [key, val] of Object.entries(pillars)) {
    if (val === null) continue;
    total += val * WEIGHTS[key].weight;
    weightSum += WEIGHTS[key].weight;
  }
  const aggregate = weightSum ? Math.round(total / weightSum) : null;
  return { aggregate, pillars, detail };
}

/* --- pillar heuristics (v0: simple, honest; refined as data sources land) --- */

const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
const driver = (label, value, score, tip) => ({ label, value, score, tip });

/* MOVE — anchored to WHO physical-activity guidelines:
   150 min/wk moderate aerobic + 2 strength sessions/wk; steps target 8k/day
   (mortality benefit plateaus ~7.5–8.5k, Paluch 2022 meta-analysis). */
function pillarMove(workouts, metrics = []) {
  const drivers = [];
  const isStrength = w => /strength|weight|gym|lift|resistance|dumbbell/i.test(w.desc || '') ||
    (w.detail?.type || '').includes('strength');
  const strength = workouts.filter(isStrength).length;
  const cardioMin = Math.round(workouts.filter(w => !isStrength(w))
    .reduce((a, w) => a + (w.detail?.moving_time_s ? w.detail.moving_time_s / 60 : 40), 0));
  if (workouts.length) {
    drivers.push(driver('Strength sessions', `${strength} of 2 / wk`, clamp(strength / 2 * 100),
      'WHO guideline is 2 strength sessions a week — even 20 focused minutes with your dumbbells counts.'));
    drivers.push(driver('Cardio minutes', `${cardioMin} of 150 min`, clamp(cardioMin / 150 * 100),
      'Aim for 150 moderate minutes a week — three 25-min walks close most of a typical gap.'));
  }
  const steps = metrics.map(m => m.steps).filter(v => v != null);
  if (steps.length) {
    drivers.push(driver('Daily steps', `avg ${Math.round(mean(steps)).toLocaleString()} of 8,000`,
      clamp(mean(steps) / 8000 * 100),
      'Benefit plateaus around 8k steps/day — a 15-min walk adds roughly 1,500.'));
  }
  return finishPillar(drivers);
}

/* FUEL — logging consistency (self-monitoring is the strongest predictor of
   weight-loss success, Burke 2011), home-cooked ratio, hydration vs the EFSA
   ~2 L/day (≈8 glasses), and alcohol with HARM-REDUCTION credit: absolute
   score follows the UK CMO low-risk guideline (≤14 units/wk), but improving
   on your own 4-week baseline scores well even before you're under it. */
function pillarFuel(foods, checkins = [], priorCheckins = [], ctx = {}) {
  const drivers = [];
  if (foods.length) {
    const daysLogged = new Set(foods.map(f => f.ts.slice(0, 10))).size;
    const homeCooked = foods.filter(f => f.source === 'cookbook').length / foods.length;
    drivers.push(driver('Food logging', `${daysLogged} of 7 days`, clamp(daysLogged / 7 * 100),
      'Self-monitoring is the single strongest predictor of weight-loss success — a photo log takes 10 seconds.'));
    drivers.push(driver('Home-cooked meals', `${Math.round(homeCooked * 100)}% of logged`, clamp(homeCooked * 100),
      'Cook from the cookbook more often — home-cooked meals average far fewer calories than takeaway.'));

    // energy & protein vs YOUR targets, on days logged fully enough to judge
    // (≥2 meals with kcal data) — needs age/sex/height in the profile
    const steps = (ctx.metrics || []).map(m => m.steps).filter(v => v != null);
    const t = energyTargets({ ...settings.profile },
      (ctx.weights || []).length ? ctx.weights[ctx.weights.length - 1].kg : null,
      { stepsAvg: steps.length ? mean(steps) : null, workoutsPerWeek: (ctx.workouts || []).length });
    if (t) {
      const byDay = {};
      for (const f of foods) {
        if (f.kcal == null) continue;
        (byDay[f.ts.slice(0, 10)] ||= { kcal: 0, protein: 0, meals: 0 });
        const d = byDay[f.ts.slice(0, 10)];
        d.kcal += f.kcal; d.protein += f.protein || 0; d.meals++;
      }
      const full = Object.values(byDay).filter(d => d.meals >= 2);
      if (full.length) {
        const avgK = mean(full.map(d => d.kcal));
        const dev = (avgK - t.target) / t.target;
        const eScore = dev >= -0.12 && dev <= 0.12 ? 100
          : dev < -0.25 ? 60
          : dev < -0.12 ? 85
          : dev <= 0.25 ? 75
          : clamp(Math.round(75 - (dev - 0.25) * 150));
        drivers.push(driver('Energy intake', `avg ${Math.round(avgK)} of ~${t.target} kcal target`, eScore,
          dev < -0.25
            ? `Eating well under target (${t.target} kcal) costs muscle and rebounds — a sustainable deficit beats a crash.`
            : `Target ≈${t.target} kcal/day (your TDEE ≈${t.tdee} − 500). Log every meal on eating days so this number is honest.`));
        const avgP = mean(full.map(d => d.protein));
        if (avgP > 0) {
          drivers.push(driver('Protein', `avg ${Math.round(avgP)}g of ${t.proteinG}g (1.6 g/kg)`,
            clamp(Math.round(avgP / t.proteinG * 100)),
            'Protein at 1.6 g/kg protects muscle while losing fat — anchor each meal on a protein source.'));
        }
      }
    }
  }
  const water = checkins.map(c => c.water).filter(v => v != null);
  if (water.length) {
    drivers.push(driver('Hydration', `avg ${mean(water).toFixed(1)} of 8 glasses`, clamp(mean(water) / 8 * 100),
      'Keep a bottle in sight — ~2 L/day; thirst is often read as hunger.'));
  }
  const drinkDays = checkins.filter(c => c.drinks != null);
  if (drinkDays.length) {
    const week = +drinkDays.reduce((a, c) => a + c.drinks, 0).toFixed(1);
    const absolute = week <= 2 ? 100 : week <= 7 ? 90 : week <= 14 ? 70 : clamp(70 - (week - 14) * 6);
    const priorDays = priorCheckins.filter(c => c.drinks != null);
    let alcohol = absolute;
    let trendNote = '';
    if (priorDays.length >= 3) {
      const priorWeekly = priorDays.reduce((a, c) => a + c.drinks, 0) / priorDays.length * 7;
      if (priorWeekly > 0) {
        const improvement = Math.max(0, Math.min(1, (priorWeekly - week) / priorWeekly));
        const credited = Math.round(60 + 40 * improvement); // cutting 5 → 1 scores ~92
        if (credited > absolute) {
          alcohol = credited;
          trendNote = ` — trend credit vs your ≈${priorWeekly.toFixed(1)}/wk baseline`;
        }
      }
    }
    drivers.push(driver('Alcohol', `${week} of ≤14 units${trendNote}`, clamp(alcohol),
      week > 14
        ? 'Over the 14-unit guideline — cutting down still scores: the app credits improvement on your own baseline.'
        : 'Under the low-risk guideline — alcohol-free days also improve sleep quality, which feeds Recover.'));
  }
  return finishPillar(drivers);
}

/* RECOVER — Garmin sleep score targets the 7–9 h consensus range (National
   Sleep Foundation); Body Battery and self-reported sleep/energy fill gaps. */
function pillarRecover(checkins, metrics = []) {
  const drivers = [];
  if (checkins.length) {
    const sleep = mean(checkins.map(c => c.sleep ?? 3));
    const energy = mean(checkins.map(c => c.energy ?? 3));
    drivers.push(driver('Self-rated sleep', `avg ${sleep.toFixed(1)} of 5`, clamp((sleep - 1) / 4 * 100),
      'Guard a consistent bedtime — the journal tags (late caffeine, screens in bed) show what drags it down.'));
    drivers.push(driver('Energy / mood', `avg ${energy.toFixed(1)} of 5`, clamp((energy - 1) / 4 * 100),
      'Persistent low energy usually points at sleep or under-fuelling on training days — raise it with Vic.'));
  }
  // Garmin day logs (sleep score + Body Battery are already 0–100 scales)
  const garmin = metrics.flatMap(m => [m.sleepScore, m.bodyBattery]).filter(v => v != null);
  if (garmin.length) {
    drivers.push(driver('Garmin recovery', `avg ${Math.round(mean(garmin))} of 100`, clamp(Math.round(mean(garmin))),
      'Sleep score and Body Battery respond most to bedtime regularity and easing alcohol/late meals.'));
  }
  // measured sleep duration (Health Connect) vs the 7–9h consensus range
  const hours = metrics.map(m => m.sleepHours).filter(v => v != null);
  const hoursScore = h => h >= 7 && h <= 9 ? 100 : h > 9 ? 85 : h >= 6 ? 80 : h >= 5 ? 55 : 30;
  if (hours.length) {
    drivers.push(driver('Sleep duration', `avg ${mean(hours).toFixed(1)}h of 7–9h`, clamp(Math.round(hoursScore(mean(hours)))),
      'Guard a consistent bedtime — 7–9 hours is where recovery, appetite hormones and training gains live.'));
  }
  return finishPillar(drivers, parts => {
    // checkin scale, Garmin scores and measured sleep hours as equal parts
    const p = [];
    if (checkins.length) {
      const sleep = mean(checkins.map(c => c.sleep ?? 3));
      const energy = mean(checkins.map(c => c.energy ?? 3));
      p.push(((sleep + energy) / 2 - 1) / 4 * 100);
    }
    if (garmin.length) p.push(mean(garmin));
    if (hours.length) p.push(hoursScore(mean(hours)));
    return p;
  });
}

function pillarConsistency(streams, checkins = []) {
  const daysActive = new Set(streams.flat().map(r => r.ts.slice(0, 10))).size;
  if (!daysActive) return { score: null, drivers: [] };
  const drivers = [driver('Days you showed up', `${daysActive} of 7 days`, clamp(Math.round(daysActive / 7 * 100)),
    'Any log counts — a weight, a check-in, a meal. Daily touch beats perfect weeks.')];
  // supplement adherence — only scored on days you actually checked in, so a
  // missed check-in never doubles as a missed supplement
  const stack = (settings.profile.supplements || '').split(',').map(s => s.trim()).filter(Boolean);
  const logged = checkins.filter(c => Array.isArray(c.supps));
  if (stack.length && logged.length) {
    const taken = logged.reduce((a, c) => a + c.supps.filter(s => stack.includes(s)).length, 0);
    const possible = logged.length * stack.length;
    drivers.push(driver('Supplements taken', `${taken} of ${possible} across ${logged.length} logged day${logged.length === 1 ? '' : 's'}`,
      clamp(Math.round(taken / possible * 100)),
      'Your stack only works if it goes in. Same time each day beats remembering.'));
  }
  const score = Math.round(mean(drivers.map(d => d.score)));
  return { score, drivers };
}

function pillarBody(weights) {
  if (weights.length < 4) {
    return { score: null, drivers: [driver('Weight trend', `${weights.length} of 4+ entries needed`, null,
      'Log weight most mornings — the score uses a smoothed trend, so daily blips never punish you.')] };
  }
  // Trend = 7-day EMA slope vs sustainable band (−0.25 to −0.75 kg/week)
  const sorted = [...weights].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const ema = [];
  const k = 2 / 8;
  for (const w of sorted) ema.push(ema.length ? w.kg * k + ema[ema.length - 1] * (1 - k) : w.kg);
  const spanDays = (Date.parse(sorted[sorted.length - 1].ts) - Date.parse(sorted[0].ts)) / 86400e3 || 1;
  const perWeek = (ema[ema.length - 1] - ema[0]) / spanDays * 7;
  let score, tip;
  if (perWeek <= -0.25 && perWeek >= -0.75) {
    score = 100; tip = 'Right in the sustainable band — this pace is the one that sticks. Protect it.';
  } else if (perWeek < -0.75) {
    score = 60; tip = 'Losing faster than 0.75 kg/wk costs muscle and rebounds — eat a little more, keep training.';
  } else if (perWeek < 0) {
    score = 80; tip = 'Losing, gently. A small nudge — one more home-cooked dinner, one more walk — reaches the band.';
  } else {
    score = clamp(Math.round(60 - perWeek * 40));
    tip = 'Trend is flat or up — go back to basics: log every meal this week and let Vic spot the leak.';
  }
  const drivers = [driver('Weight trend', `${perWeek >= 0 ? '+' : ''}${perWeek.toFixed(2)} kg/wk (band −0.25 to −0.75)`, score, tip)];
  return { score, drivers };
}

/* Pillar score = mean of driver scores, unless the pillar supplies its own
   parts function (Recover keeps its original two-part maths). */
function finishPillar(drivers, partsFn = null) {
  const scored = drivers.filter(d => d.score != null);
  if (!scored.length) return { score: null, drivers };
  const parts = partsFn ? partsFn() : scored.map(d => d.score);
  return { score: clamp(Math.round(mean(parts))), drivers };
}

export function trendWeight(weights) {
  if (!weights.length) return null;
  const sorted = [...weights].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const k = 2 / 8;
  return sorted.reduce((ema, w) => ema === null ? w.kg : w.kg * k + ema * (1 - k), null);
}

const clamp = n => Math.max(0, Math.min(100, n));
