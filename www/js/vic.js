/* vic.js — Vic, the coach. Claude API with the on-device key (cookbook pattern).
   Persona per SPEC.md §2: slightly patient, no excuses, inspiring, with
   data-grounded "Did you know" insights. */

import { settings, logs } from './store.js';
import { weeklyScore } from './score.js';
import { activePlan, sessionForToday, latestMeasurement, latestBenchmark } from './plan.js';

const MODEL = 'claude-opus-4-8';

/* Generic Claude call reused by food vision, nutrition estimates and meal planning.
   content may be a string or an array of content blocks (e.g. image + text). */
export async function claude(content, { system, maxTokens = 2000 } = {}) {
  const apiKey = settings.apiKey;
  if (!apiKey) throw new Error('NO_KEY');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: MODEL, max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content }],
    }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch {}
    throw new Error(`AI request failed (${res.status}). ${detail.slice(0, 140)}`);
  }
  const data = await res.json();
  return (data.content || []).find(b => b.type === 'text')?.text.trim() || '';
}

export function parseJson(text) {
  return JSON.parse(text.replace(/^```(json)?\s*/i, '').replace(/```\s*$/, ''));
}

function personaPrompt(profile, context) {
  return `You are Vic, ${profile.name}'s AI personal trainer inside their Trainer App.

PERSONA — non-negotiable:
- Slightly patient but NO EXCUSES. Acknowledge an obstacle once, with empathy, then move
  immediately to the adjusted action ("okay, knees are sore — we swap squats for hip
  thrusts, we don't skip"). Never accept skipping without offering a smaller alternative.
- Inspire and encourage better behaviour. Celebrate real wins with specifics from the
  data. Never shame, never guilt-trip; redirect forward.
- Regularly (roughly every 2–3 replies, when natural) drop a "Did you know…" —
  either a fact from ${profile.name}'s OWN data in the context below, or a genuinely
  evidence-based benefit of the behaviour you're coaching right now. Only cite personal
  stats that appear in the context. Only state general facts you are confident are true.
  Mark them like: Did you know: …
- Voice: warm, direct, economical. Short paragraphs. No corporate fluff. He/him.

GOAL: ${profile.goal}. Sustainable target rate: ${profile.targetRate}. Watch: ${profile.watch}.
${profile.injuries ? `Injuries/limits: ${profile.injuries}.` : ''}
Equipment: ${profile.equipment}. Preferred modalities: ${profile.modalities}.
Session budget: ${profile.sessionMinutes} min including warm-up and cool-down.
Tone dial: ${profile.tone}.

PLAN GUIDANCE: you coach through a structured plan — monthly theme, weekly focus, workout
of the day (shown in the data below when one is active). Frame advice against the current
week's focus. If no plan exists yet, steer toward the measure-and-benchmark session first
(Me tab), then plan generation (Train tab) — measurement before prescription, always.

CURRENT DATA (real, from the app — the only personal stats you may cite):
${context}

You cannot yet write to the app's logs or other services; if asked to log something, give
the exact steps in the app instead, and keep coaching.`;
}

async function buildContext() {
  const [{ aggregate, pillars }, weights, workouts, journal] = await Promise.all([
    weeklyScore(), logs.recent('weights', 28), logs.recent('workouts', 7), logs.recent('journal', 7),
  ]);
  const lines = [];
  lines.push(aggregate === null
    ? 'Lifestyle Score: no data yet (calibration not complete).'
    : `Weekly Lifestyle Score: ${aggregate}/100. Pillars: ` +
      Object.entries(pillars).map(([k, v]) => `${k}=${v === null ? 'n/a' : v}`).join(', ') + '.');
  if (weights.length) {
    const latest = weights[weights.length - 1];
    lines.push(`Weight entries last 28d: ${weights.length}, latest ${latest.kg} kg.`);
  }
  lines.push(`Workouts logged last 7d: ${workouts.length}.`);
  if (journal.length) {
    const tags = journal.flatMap(j => j.tags || []);
    lines.push(`Journal tags last 7d: ${tags.join(', ') || 'none'}.`);
  }
  const [meas, bench, plan] = await Promise.all([latestMeasurement(), latestBenchmark(), activePlan()]);
  if (meas) lines.push(`Latest tape measurements: ${JSON.stringify({ waist: meas.waist, hips: meas.hips, chest: meas.chest, arm: meas.arm, thigh: meas.thigh })} (taken ${meas.ts.slice(0, 10)}).`);
  if (bench) lines.push(`Latest benchmarks: ${JSON.stringify({ restingHr: bench.restingHr, run1600mSec: bench.runSec, pushups: bench.pushups, plankSec: bench.plankSec, gobletSquat: bench.squatReps })} (taken ${bench.ts.slice(0, 10)}).`);
  if (!meas && !bench) lines.push('No measurements or benchmarks yet — the measuring session has not happened.');
  if (plan) {
    const t = sessionForToday(plan.plan);
    lines.push(`Active plan: month theme "${plan.plan.month_theme}", week ${t.week ? t.week.week : '-'} focus "${t.week ? t.week.theme : '-'}".`);
    if (t.status === 'today') lines.push(`Today's session: ${t.session.title} (${t.session.type}, ${t.session.duration_min} min).`);
    else if (t.status === 'rest') lines.push('Today is a rest day on the plan.');
    else if (t.status === 'starts') lines.push(`Plan starts ${t.when}.`);
  } else {
    lines.push('No training plan active yet.');
  }
  return lines.join('\n');
}

export async function askVic(history) {
  const apiKey = settings.apiKey;
  if (!apiKey) throw new Error('NO_KEY');
  const context = await buildContext();
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: personaPrompt(settings.profile, context),
        messages: history,
      }),
    });
  } catch (e) {
    throw new Error('Could not reach the AI service — ' + (e?.message || e));
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch {}
    if (res.status === 401) throw new Error('API key rejected — check it in Me → Settings.');
    if (res.status === 429) throw new Error('Rate limit hit — give it a minute.');
    throw new Error(`AI request failed (${res.status}). ${detail.slice(0, 140)}`);
  }
  const data = await res.json();
  return (data.content || []).find(b => b.type === 'text')?.text.trim() || '';
}
