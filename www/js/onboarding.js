/* onboarding.js — the setup journey (SPEC §8).
   A paged, gated flow that unlocks the day-to-day app:
   welcome → what's inside → setup (live ✓ confirmations) → meet Vic →
   Vic's requirements step by step (profile → weigh-in → tape → benchmarks) → unlock.
   Re-entrant: every gate re-checks reality, so finished parts show as done. */

import { $, el, esc } from './ui.js';
import { settings, logs, defaultProfile } from './store.js';
import { signedIn } from './sync.js';
import { stravaConnected } from './strava.js';
import { latestMeasurement, latestBenchmark, activePlan, generatePlan } from './plan.js';
import { vicAvatar } from './vic-avatar.js';
import { vicSprite } from './vic-sprite.js';

let deps = null;   // sheets + exit callback injected by app.js (avoids an import cycle)
let idx = 0;
let active = false;

export function initOnboarding(d) { deps = d; }
export const journeyActive = () => active;

export function startJourney(fromIndex = 0) {
  active = true;
  idx = fromIndex;
  document.body.classList.add('journey-mode');
  renderJourney();
}

function finishJourney() {
  settings.save({ onboardingDone: true });
  active = false;
  document.body.classList.remove('journey-mode');
  deps.onDone();
}

/* ---------- gate checks (async, re-evaluated on every render) ---------- */
async function gates() {
  const [meas, bench, weights, plan] = await Promise.all([
    latestMeasurement(), latestBenchmark(), logs.all('weights'), activePlan(),
  ]);
  return {
    apiKey: !!settings.apiKey,
    cloud: signedIn(),
    strava: stravaConnected(),
    profile: !!settings.load().profileConfirmed,
    weight: weights.length > 0,
    tape: !!meas,
    bench: !!bench,
    plan: !!plan,
  };
}

/* ---------- building blocks ---------- */
const vicSays = (...lines) => el('div', { class: 'vic-bubble' },
  el('div', { class: 'vic-face' }, vicSprite(52, 'still')),
  el('div', {}, ...lines.map(l => el('p', {}, l))));

function checkRow(done, label, sub, btnLabel, onclick) {
  return el('div', { class: 'j-check' + (done ? ' done' : '') },
    el('span', { class: 'j-tick' }, done ? '✓' : '○'),
    el('div', { class: 'grow' },
      el('b', {}, label),
      el('p', { class: 'muted', style: 'font-size:13px' }, done ? 'Done ✓' : sub)),
    done ? null : el('button', { class: 'chip', onclick }, btnLabel));
}

/* ---------- pages ---------- */
const PAGES = [
  { // 0 — welcome splash
    render: async () => el('div', { class: 'j-page j-center' },
      el('div', { class: 'vic-hero' }, vicSprite(240)),
      el('h1', { class: 'j-title' }, 'Trainer App'),
      el('p', { class: 'j-tag' }, 'Your coach. Your kitchen. Your watch. One score.'),
      el('p', { class: 'muted', style: 'margin-top:14px;max-width:300px' },
        'A short setup journey unlocks everything — a few minutes, once.')),
    next: 'Begin',
  },
  { // 1 — what's inside
    render: async () => el('div', { class: 'j-page' },
      el('h1', { class: 'j-title' }, 'What’s inside'),
      featureCard('🥊', 'Vic, your coach', 'A patient-but-no-excuses AI trainer who plans your month, week and workout of the day — and re-plans when life happens.'),
      featureCard('💯', 'One Lifestyle Score', 'Training, food, recovery and consistency in one honest number — benchmarked at your start, tracked forever.'),
      featureCard('🍲', 'Your whole life, connected', 'Aphile’s Cookbook feeds the meal plan. Your Garmin feeds recovery. Strava feeds training. Everything counts.')),
    next: 'Set me up',
  },
  { // 2 — app setup with live confirmations
    render: async () => {
      const g = await gates();
      return el('div', { class: 'j-page' },
        el('h1', { class: 'j-title' }, 'App setup'),
        el('p', { class: 'muted', style: 'margin-bottom:14px' }, 'Green ticks unlock the good stuff. Two are optional — skip and add them later in Me → Settings.'),
        checkRow(g.apiKey, 'Anthropic API key', 'Vic’s voice — required. Stored only on this device.', 'Add key', deps.sheets.apiKey),
        checkRow(g.cloud, 'Cloud sync', 'Backs up every log and connects the cookbook. Recommended.', 'Sign in', deps.sheets.cloud),
        checkRow(g.strava, 'Strava (optional)', 'Runs and rides import themselves.', 'Connect', deps.sheets.strava),
        el('p', { class: 'muted', style: 'margin-top:12px;font-size:13px' },
          '🍲 Cookbook sync is switched on from the cookbook app itself: Settings → Trainer App sync.'));
    },
    canNext: g => g.apiKey,
    nextHint: 'Add your API key to continue — Vic can’t coach without a voice.',
    next: 'Continue',
  },
  { // 3 — meet Vic
    render: async () => el('div', { class: 'j-page' },
      el('div', { class: 'vic-hero' }, vicSprite(190)),
      el('h1', { class: 'j-title', style: 'text-align:center' }, 'Meet Vic'),
      vicSays(
        'I’m Vic. Here’s how this works: sustainable weight loss, measured properly, no crash diets, no guesswork.',
        'I’ll hear any obstacle out once — then we find the smaller version of the workout, not the excuse. Sore knees? We swap squats. Busy day? Thirty minutes. We don’t skip.',
        'Did you know: people who set a measured baseline before starting are far more likely to still be training at week eight? That’s why I measure before I prescribe.',
        'Four quick things and I can build your first month. Ready?')),
    next: 'Let’s do this',
  },
  { // 4 — Vic step 1: profile
    render: async () => {
      const g = await gates();
      const p = { ...defaultProfile(), ...settings.profile };
      const injuries = el('input', { value: p.injuries, placeholder: 'e.g. left knee — no deep squats (or leave blank)' });
      const equipment = el('input', { value: p.equipment });
      const minutes = el('input', { type: 'number', value: p.sessionMinutes, min: 15, max: 180, step: 5 });
      const tone = el('select', {}, ...['gentle', 'balanced', 'direct'].map(t =>
        el('option', { value: t, selected: p.tone === t }, t[0].toUpperCase() + t.slice(1))));
      return el('div', { class: 'j-page' },
        el('p', { class: 'j-step' }, 'Vic’s setup — step 1 of 4'),
        vicSays('First: what I’m working with. Your goal is locked — sustainable weight loss at ' + esc(p.targetRate) + '. Check the rest.'),
        el('div', { class: 'field' }, el('label', {}, 'Injuries / limits (I work around these, not through them)'), injuries),
        el('div', { class: 'field' }, el('label', {}, 'Your kit (drives every plan I write)'), equipment),
        el('div', { class: 'field' }, el('label', {}, 'Session budget — minutes, warm-up and cool-down included'), minutes),
        el('div', { class: 'field' }, el('label', {}, 'How do you want me?'), tone),
        el('button', {
          class: 'btn' + (g.profile ? ' ghost' : ''), style: 'margin-top:6px',
          onclick: () => {
            settings.save({
              profile: { ...p, injuries: injuries.value, equipment: equipment.value,
                sessionMinutes: parseInt(minutes.value) || 60, tone: tone.value },
              profileConfirmed: true,
            });
            renderJourney();
          },
        }, g.profile ? 'Saved ✓ (save again)' : 'Save — that’s me'));
    },
    canNext: g => g.profile,
    nextHint: 'Save your details first.',
    next: 'Next',
  },
  { // 5 — Vic step 2: first weigh-in
    render: async () => {
      const g = await gates();
      return el('div', { class: 'j-page' },
        el('p', { class: 'j-step' }, 'Vic’s setup — step 2 of 4'),
        vicSays(
          'On the scale. One number, no judgement — it’s a starting line, not a verdict.',
          'Did you know: I only ever coach off your 7-day trend, never a single day’s spike. Water weight lies; trends don’t.'),
        checkRow(g.weight, 'First weigh-in', 'Morning, after the bathroom, before breakfast is best.', 'Log weight', deps.sheets.weight));
    },
    canNext: g => g.weight,
    nextHint: 'Log a weight to continue.',
    next: 'Next',
  },
  { // 6 — Vic step 3: tape
    render: async () => {
      const g = await gates();
      return el('div', { class: 'j-page' },
        el('p', { class: 'j-step' }, 'Vic’s setup — step 3 of 4'),
        vicSays(
          'Tape measure time. Waist, hips, chest, arm, thigh — same spots every 4 weeks.',
          'Did you know: when weight stalls, the tape usually doesn’t. Muscle in, fat out can be invisible on the scale and obvious on the waist.'),
        checkRow(g.tape, 'Tape measurements', 'Relaxed, not sucked in. Honest numbers only.', 'Measure', deps.sheets.tape));
    },
    canNext: g => g.tape,
    nextHint: 'At least one tape measurement to continue.',
    next: 'Next',
  },
  { // 7 — Vic step 4: benchmarks
    render: async () => {
      const g = await gates();
      return el('div', { class: 'j-page' },
        el('p', { class: 'j-step' }, 'Vic’s setup — step 4 of 4'),
        vicSays(
          'Last one: benchmarks. Resting heart rate, a timed 1.6 km, max push-ups, a plank, goblet squats. This is what makes your first month fit YOU — not a template.',
          'Don’t have time to test everything today? Log what you can now; the rest tonight or tomorrow.'),
        checkRow(g.bench, 'Fitness & strength benchmarks', 'Warm up first. Every 8 weeks we re-test and compare.', 'Do benchmarks', deps.sheets.bench));
    },
    canNext: g => g.bench,
    nextHint: 'Log at least one benchmark to continue.',
    next: 'Next',
  },
  { // 8 — unlocked
    render: async () => {
      const g = await gates();
      const planBtn = el('button', { class: 'btn', style: 'margin-top:14px' },
        g.plan ? 'Plan ready ✓' : 'Vic, build my first month');
      if (g.plan) planBtn.disabled = true;
      planBtn.addEventListener('click', async () => {
        planBtn.disabled = true; planBtn.textContent = 'Vic is planning… (~30s)';
        try { await generatePlan(); planBtn.textContent = 'Plan ready ✓'; }
        catch (e) { planBtn.disabled = false; planBtn.textContent = 'Try again — ' + e.message.slice(0, 40); }
      });
      return el('div', { class: 'j-page j-center' },
        el('div', { class: 'vic-hero' }, vicSprite(200)),
        el('h1', { class: 'j-title' }, 'You’re in'),
        vicSays(
          'Baseline captured. That took discipline — first tick earned.',
          'The next two weeks are calibration: live normally, log honestly, and your Lifestyle Score baseline sets itself. Then we push.'),
        planBtn);
    },
    next: 'Enter the app',
    isLast: true,
  },
];

function featureCard(emoji, title, text) {
  return el('div', { class: 'card', style: 'display:flex;gap:12px;align-items:flex-start' },
    el('span', { style: 'font-size:28px' }, emoji),
    el('div', {}, el('b', {}, title), el('p', { class: 'muted', style: 'font-size:14px;margin-top:2px' }, text)));
}

/* ---------- renderer ---------- */
export async function renderJourney() {
  if (!active) return;
  const page = PAGES[idx];
  const g = await gates();
  const root = $('#screen');
  root.replaceChildren();

  const dots = el('div', { class: 'j-dots' },
    ...PAGES.map((_, i) => el('span', { class: 'j-dot' + (i === idx ? ' on' : i < idx ? ' past' : '') })));

  const nextOk = !page.canNext || page.canNext(g);
  const nextBtn = el('button', {
    class: 'btn', style: 'flex:1',
    onclick: () => {
      if (page.isLast) { finishJourney(); return; }
      idx += 1; renderJourney();
      $('#screen').scrollTop = 0; window.scrollTo(0, 0);
    },
  }, page.next);
  if (!nextOk) nextBtn.disabled = true;

  const nav = el('div', { class: 'j-nav' },
    idx > 0 ? el('button', { class: 'btn ghost', onclick: () => { idx -= 1; renderJourney(); } }, 'Back') : null,
    nextBtn);

  root.append(
    el('div', { class: 'journey' },
      dots,
      await page.render(),
      (!nextOk && page.nextHint) ? el('p', { class: 'muted', style: 'text-align:center;font-size:13px;margin-top:8px' }, page.nextHint) : null,
      nav));
}
