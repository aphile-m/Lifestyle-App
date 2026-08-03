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

You cannot write to the app's logs yourself — but you CAN put the right logging form one
tap away. Whenever you ask ${profile.name} to log or measure something, end your reply
with the matching tag(s), each on its own line, chosen from exactly:
[log:benchmarks] [log:tape] [log:weight] [log:checkin] [log:workout] [log:meal]
The app hides the tag text and renders a button that opens that form right here in the
chat. Always use a tag instead of describing menu navigation.`;
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
  // strength memory: newest set data per exercise so load/effort advice is grounded
  const lifts = await logs.recent('workouts', 28);
  lifts.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  const seen = {};
  for (const w of lifts) {
    for (const e of (w.detail?.sets || [])) {
      const k = e.name?.toLowerCase();
      if (!k || seen[k]) continue;
      const sets = (e.sets || []).filter(Boolean);
      if (!sets.length) continue;
      const star = r => Math.min(5, Math.max(1, Math.round(r / 2)));
      seen[k] = `${e.name}: ` + sets.map(s =>
        `${s.reps ?? (s.secs ? s.secs + 's' : '?')}${s.kg ? '@' + s.kg + 'kg' : ''}${s.rpe ? ' effort ' + star(s.rpe) + '/5' : ''}`).join(', ');
    }
  }
  const liftLines = Object.values(seen).slice(0, 12);
  if (liftLines.length) {
    lines.push('Latest set data per exercise (reps@kg, effort in stars /5 — the user rates effort as 1=recovery, 2=comfortable (4+ reps left), 3=working (~2 reps left, the target), 4=hard (1 rep left), 5=max/failed): ' +
      liftLines.join(' | ') +
      '. Progression rule: reps hit at effort <=3/5 -> +2.5 kg next time; 5/5 or reps missed -> hold the load. Speak in stars, not RPE.');
  }
  if (journal.length) {
    const tags = journal.flatMap(j => j.tags || []);
    lines.push(`Journal tags last 7d: ${tags.join(', ') || 'none'}.`);
  }
  const checkins = await logs.recent('checkins', 35);
  const wk = checkins.filter(c => Date.parse(c.ts) >= Date.now() - 7 * 86400e3);
  const water = wk.map(c => c.water).filter(v => v != null);
  if (water.length) lines.push(`Water: avg ${(water.reduce((a, b) => a + b, 0) / water.length).toFixed(1)} glasses/day this week (guide: ~8).`);
  const dk = wk.filter(c => c.drinks != null);
  if (dk.length) {
    const weekUnits = +dk.reduce((a, c) => a + c.drinks, 0).toFixed(1);
    const prior = checkins.filter(c => Date.parse(c.ts) < Date.now() - 7 * 86400e3 && c.drinks != null);
    const priorWeekly = prior.length ? (prior.reduce((a, c) => a + c.drinks, 0) / prior.length * 7).toFixed(1) : null;
    const mix = {};
    for (const c of dk) for (const [k, n] of Object.entries(c.drinksDetail || {})) if (n) mix[k] = (mix[k] || 0) + n;
    const mixStr = Object.entries(mix).map(([k, n]) => `${n} ${k}`).join(', ');
    lines.push(`Alcohol: ${weekUnits} units this week (UK guide: ≤14/wk)${mixStr ? ` — mix: ${mixStr}` : ''}${priorWeekly ? ` (recent baseline ≈${priorWeekly} units/wk — coach the TREND: cutting down deserves credit, per harm-reduction practice)` : ''}.`);
  }
  const cf = wk.map(c => c.coffee).filter(v => v != null);
  if (cf.length) lines.push(`Caffeine: avg ${(cf.reduce((a, b) => a + b, 0) / cf.length).toFixed(1)} coffees/day this week (guide: ≤4 cups ≈ 400 mg; none within 8h of bed for sleep quality).`);
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

/* One-shot Vic commentary — full persona + live data, no chat history.
   Used by the Insights page so the breakdown arrives in Vic's voice. */
export async function vicBriefing(ask, extraContext = '') {
  if (!settings.apiKey) throw new Error('NO_KEY');
  const context = (await buildContext()) + (extraContext ? '\n' + extraContext : '');
  return claude(ask, { system: personaPrompt(settings.profile, context), maxTokens: 600 });
}

/* Life got busy: the athlete moves today's session to another day and Vic
   rearranges the rest of the week around it, keeping the goal in mind. */
export async function replanWeek(week, session, todayDow, targetDow) {
  const days = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const text = await vicBriefing(
    `The athlete can't train today (${days[todayDow]}) and wants today's session "${session.title}" moved to ${days[targetDow]}. ` +
    `Rearrange the REMAINING days of this training week if it helps recovery and the goal — sessions on days already past stay where they are. ` +
    `Week ${week.week} (${week.theme}) sessions: ` +
    JSON.stringify((week.sessions || []).map(s => ({ dow: s.dow, title: s.title, type: s.type }))) + '. ' +
    `dow is 1=Monday…7=Sunday; today is dow ${todayDow}. Rules: one session per day; keep every exact title; ` +
    `"${session.title}" MUST land on dow ${targetDow}; avoid back-to-back strength days when you can. ` +
    `Return ONLY JSON, no prose: {"sessions":[{"title":"<exact title>","dow":N}, …one entry for EVERY session of the week…],` +
    `"note":"1-2 sentences in your voice: what you moved and why the week still works for the goal"}`);
  return parseJson(text);
}

export async function askVic(history, extraContext = '') {
  const apiKey = settings.apiKey;
  if (!apiKey) throw new Error('NO_KEY');
  const context = (await buildContext()) + (extraContext ? '\n' + extraContext : '');
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
