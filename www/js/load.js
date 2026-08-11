/* load.js — training load, so an hour of boxing outranks four hours of golf.

   Counting minutes treats every minute as equal, which is plainly wrong: a
   round of golf at a stroll is not four boxing sessions. The standard fix in
   sports science is Banister's TRIMP (Banister & Calvert 1980), which weights
   each minute by how hard the heart was working, exponentially:

     load = minutes × HRr × k × e^(b × HRr)
     HRr  = (avg HR − resting HR) / (max HR − resting HR)     "heart-rate reserve"
     k,b  = 0.64, 1.92 (male) · 0.86, 1.67 (female)

   The exponent is what makes intensity beat duration: at HRr 0.7 a minute is
   worth ~5x a minute at HRr 0.3, so four easy hours still lose to one hard one.

   Not every session has a heart-rate trace, so load falls back through three
   bases, best first:
     1. measured average HR (Strava, Health Connect)
     2. your effort stars, mapped to the HRr they typically correspond to
     3. the activity name, matched against typical intensities

   The unit is "AU" (arbitrary units) — meaningful only against your own history
   and the weekly target below.
*/

import { settings } from './store.js';

/* WHO: 150 min moderate OR 75 min vigorous aerobic activity per week. Those two
   land within a couple of AU of each other on this curve (151 vs 152), which is
   a decent sign the model is behaving — so 150 AU is the same guideline,
   expressed in a way that finally distinguishes a stroll from a spar. */
export const WEEKLY_LOAD_TARGET = 150;

/* Tanaka 2001 — more accurate across ages than 220−age, and it matters here
   because HRr sits inside an exponent. */
export function maxHr(profile = settings.profile) {
  return profile?.age ? Math.round(208 - 0.7 * profile.age) : 190;
}
export const DEFAULT_RESTING_HR = 60;

/* Effort stars → the heart-rate reserve that effort usually corresponds to.
   Anchored on the Borg CR10 ↔ %HRR relation: "easy" sits near 0.3, "all out"
   near 0.85. */
const STAR_HRR = { 1: 0.30, 2: 0.42, 3: 0.55, 4: 0.68, 5: 0.82 };

/* Last-resort intensities by activity, for imports with no HR and no effort
   rating. Deliberately conservative — a guess should never outscore a
   measurement. Order matters: first match wins. */
const ACTIVITY_HRR = [
  [/box|spar|hiit|circuit|crossfit|sprint|squash/i, 0.75],
  [/run|jog|row|swim|skip|rope/i, 0.68],
  [/ride|cycl|bike|spin|elliptical|stair/i, 0.62],
  [/strength|weight|gym|lift|resistance|dumbbell|bodyweight/i, 0.55],
  [/tennis|padel|football|soccer|basketball|hike/i, 0.60],
  [/walk|golf|bowls|stretch|yoga|mobility|pilates|stroll/i, 0.32],
];

/* Duration in minutes, best source first. Falls back to the profile's usual
   session length rather than 0 — a logged session definitely wasn't zero long. */
export function sessionMinutes(w, profile = settings.profile) {
  const d = w?.detail || {};
  if (d.moving_time_s) return d.moving_time_s / 60;
  if (d.minutes) return d.minutes;
  return profile?.sessionMinutes || 45;
}

function hrrFor(w) {
  const d = w?.detail || {};
  const rest = d.resting_hr || DEFAULT_RESTING_HR;
  const max = maxHr();
  if (d.avg_hr && d.avg_hr > rest && max > rest) {
    return { hrr: Math.min(1, (d.avg_hr - rest) / (max - rest)), basis: 'heart rate' };
  }
  if (w?.rpe) {
    // rpe is stored 1–10 (effort stars × 2), so halve it back to stars
    const stars = Math.max(1, Math.min(5, Math.round(w.rpe / 2)));
    return { hrr: STAR_HRR[stars], basis: 'your effort rating' };
  }
  const text = `${w?.desc || ''} ${w?.detail?.type || ''}`;
  for (const [re, hrr] of ACTIVITY_HRR) if (re.test(text)) return { hrr, basis: 'activity type' };
  return { hrr: 0.5, basis: 'estimate' };
}

/* Banister TRIMP for one session → {au, minutes, hrr, basis}. */
export function sessionLoad(w, profile = settings.profile) {
  const minutes = sessionMinutes(w, profile);
  const { hrr, basis } = hrrFor(w);
  const female = profile?.sex === 'female';
  const k = female ? 0.86 : 0.64;
  const b = female ? 1.67 : 1.92;
  return { au: Math.round(minutes * hrr * k * Math.exp(b * hrr)), minutes: Math.round(minutes), hrr, basis };
}

/* Load per minute, i.e. how hard it was independent of how long. Useful for
   "that round of golf was four hours and still the easiest thing you did". */
export const loadRate = w => {
  const l = sessionLoad(w);
  return l.minutes ? l.au / l.minutes : 0;
};

export function weeklyLoad(workouts) {
  const rows = workouts.map(w => ({ w, ...sessionLoad(w) }));
  return { total: rows.reduce((a, r) => a + r.au, 0), minutes: rows.reduce((a, r) => a + r.minutes, 0), rows };
}

/* Plain-language band for a single session, for the log list and Vic. */
export function loadBand(au) {
  if (au >= 120) return 'very hard';
  if (au >= 70) return 'hard';
  if (au >= 35) return 'moderate';
  if (au >= 15) return 'easy';
  return 'very easy';
}

export const fmtMinutes = m =>
  m >= 60 ? `${Math.floor(m / 60)}h${String(Math.round(m % 60)).padStart(2, '0')}` : `${Math.round(m)}min`;
