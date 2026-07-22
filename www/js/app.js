/* app.js — shell, tab router, and v0 screens (see SPEC.md §8) */

import { $, el, esc, scoreRing, sheet, toast } from './ui.js';
import { settings, logs, defaultProfile } from './store.js';
import { weeklyScore, trendWeight, WEIGHTS } from './score.js';
import { askVic } from './vic.js';

const JOURNAL_TAGS = ['Late caffeine', 'Alcohol', 'Late meal', 'Screens in bed', 'Stretching', 'Cold shower', 'Reading in bed', 'Travel'];

const screens = { today, coach, train, fuel, me };
let chatHistory = []; // this session's Vic conversation (persisted turns go to IndexedDB)

function go(tab) {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('#screen').replaceChildren();
  screens[tab]($('#screen'));
  localStorage.setItem('trainer_tab', tab);
}

document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => go(b.dataset.tab)));
go(localStorage.getItem('trainer_tab') || 'today');

/* ---------------- Today ---------------- */
async function today(root) {
  root.append(el('h1', { class: 'h-page' }, todayGreeting()));

  // Lifestyle Score card
  const { aggregate, pillars } = await weeklyScore();
  const pillarRows = Object.entries(WEIGHTS).map(([key, { label }]) => {
    const v = pillars[key];
    return el('div', { class: 'pillar' },
      el('span', {}, label),
      el('span', { class: 'bar' }, el('i', { style: `width:${v ?? 0}%` })),
      el('span', { class: 'val' }, v === null ? '–' : String(v)));
  });
  root.append(el('div', { class: 'card' },
    el('h2', {}, 'Lifestyle Score — this week'),
    el('div', { class: 'score-wrap' }, scoreRing(aggregate), el('div', { class: 'pillars' }, ...pillarRows)),
    aggregate === null
      ? el('p', { class: 'muted', style: 'margin-top:10px' },
          'Calibration in progress — log normally for two weeks to set your honest baseline. Vic explains why in the Coach tab.')
      : null));

  // Quick log
  root.append(el('div', { class: 'card' },
    el('h2', {}, 'Quick log'),
    el('div', { class: 'chips' },
      el('button', { class: 'chip', onclick: logWeightSheet }, '⚖️ Weight'),
      el('button', { class: 'chip', onclick: () => logMealSheet() }, '🍲 Meal'),
      el('button', { class: 'chip', onclick: logWorkoutSheet }, '🏋️ Workout'))));

  // Evening check-in with journal quick-tags (SPEC §6)
  root.append(el('div', { class: 'card' },
    el('h2', {}, 'Evening check-in'),
    el('p', { class: 'muted' }, 'Tap what happened today, then rate the day. 30 seconds, honest answers.'),
    checkinForm()));
}

function todayGreeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Morning. Let’s move.' : h < 18 ? 'Afternoon check.' : 'Evening review.';
}

function checkinForm() {
  const tags = new Set();
  const chipRow = el('div', { class: 'chips', style: 'margin:10px 0' },
    ...JOURNAL_TAGS.map(t => el('button', {
      class: 'chip',
      onclick: e => { e.target.classList.toggle('on'); tags.has(t) ? tags.delete(t) : tags.add(t); },
    }, t)));
  const sleep = ratingRow('Sleep quality');
  const energy = ratingRow('Energy / mood');
  return el('div', {}, chipRow, sleep.row, energy.row,
    el('button', {
      class: 'btn', style: 'margin-top:10px', onclick: async () => {
        await logs.add('journal', { tags: [...tags] });
        await logs.add('checkins', { sleep: sleep.value(), energy: energy.value() });
        toast('Checked in. Vic sees this.');
        go('today');
      },
    }, 'Save check-in'));
}

function ratingRow(label) {
  let val = 3;
  const btns = [1, 2, 3, 4, 5].map(n => el('button', {
    class: 'chip' + (n === 3 ? ' on' : ''),
    onclick: e => {
      val = n;
      [...e.target.parentNode.children].forEach(c => c.classList.remove('on'));
      e.target.classList.add('on');
    },
  }, String(n)));
  return {
    row: el('div', { class: 'row', style: 'margin:8px 0' },
      el('span', { class: 'muted', style: 'width:110px' }, label), el('div', { class: 'chips grow' }, ...btns)),
    value: () => val,
  };
}

/* ---------------- Coach (Vic) ---------------- */
async function coach(root) {
  root.append(el('h1', { class: 'h-page' }, 'Vic'));
  const chat = el('div', { class: 'chat' });
  root.append(chat);

  const stored = await logs.recent('chat', 2);
  for (const m of stored) bubble(chat, m.role === 'user' ? 'me' : 'vic', m.text);
  if (!stored.length) {
    bubble(chat, 'vic',
      'I’m Vic. One goal on the board: sustainable weight loss, measured properly. ' +
      'First two weeks are calibration — live normally, log honestly, and we’ll know your real starting line. ' +
      'No excuses after that, but no guesswork either. What’s on your mind?');
  }

  const input = el('input', { placeholder: 'Talk to Vic…', enterkeyhint: 'send' });
  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    if (!settings.apiKey) { apiKeySheet(); return; }
    input.value = '';
    bubble(chat, 'me', text);
    chatHistory.push({ role: 'user', content: text });
    await logs.add('chat', { role: 'user', text });
    const thinking = bubble(chat, 'vic thinking', 'Vic is thinking…');
    try {
      const reply = await askVic(chatHistory.slice(-20));
      thinking.remove();
      bubble(chat, 'vic', reply);
      chatHistory.push({ role: 'assistant', content: reply });
      await logs.add('chat', { role: 'assistant', text: reply });
    } catch (e) {
      thinking.remove();
      if (e.message === 'NO_KEY') { apiKeySheet(); return; }
      bubble(chat, 'vic', '⚠️ ' + e.message);
    }
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
  root.append(el('div', { class: 'chat-input' }, input, el('button', { class: 'btn', onclick: send }, 'Send')));
  chat.scrollIntoView(false);
}

function bubble(chat, cls, text) {
  const b = el('div', { class: 'bubble ' + cls }, text);
  chat.append(b);
  b.scrollIntoView({ block: 'end' });
  return b;
}

/* ---------------- Train ---------------- */
async function train(root) {
  root.append(el('h1', { class: 'h-page' }, 'Train'));
  const workouts = await logs.recent('workouts', 7);
  root.append(el('div', { class: 'card' },
    el('h2', {}, 'This week'),
    el('p', {}, `${workouts.length} session${workouts.length === 1 ? '' : 's'} logged.`),
    el('p', { class: 'muted' }, 'Plan generation, the workout player, and Strava sync land next (SPEC §4). For now, log sessions so calibration counts them.'),
    el('button', { class: 'btn', style: 'margin-top:10px', onclick: logWorkoutSheet }, 'Log a session')));
}

/* ---------------- Fuel ---------------- */
async function fuel(root) {
  root.append(el('h1', { class: 'h-page' }, 'Fuel'));
  const foods = await logs.recent('foods', 7);
  root.append(el('div', { class: 'card' },
    el('h2', {}, 'This week'),
    el('p', {}, `${foods.length} meal${foods.length === 1 ? '' : 's'} logged.`),
    el('p', { class: 'muted' }, 'Cookbook sync (pantry in, meal plans out), photo logging, and macro targets land next (SPEC §5). Manual logging counts toward calibration.'),
    el('button', { class: 'btn', style: 'margin-top:10px', onclick: () => logMealSheet() }, 'Log a meal')));
}

/* ---------------- Me ---------------- */
async function me(root) {
  root.append(el('h1', { class: 'h-page' }, 'Me'));
  const weights = await logs.recent('weights', 28);
  const trend = trendWeight(weights);
  root.append(el('div', { class: 'card' },
    el('h2', {}, 'Trend weight (7-day EMA)'),
    el('p', { style: 'font-size:28px;font-weight:700' }, trend ? `${trend.toFixed(1)} kg` : 'No entries yet'),
    el('p', { class: 'muted' }, 'The trend is the headline — never the daily spike.'),
    el('button', { class: 'btn ghost', style: 'margin-top:10px', onclick: logWeightSheet }, 'Log weight')));

  const p = settings.profile;
  root.append(el('div', { class: 'card' },
    el('h2', {}, 'Profile & goal'),
    el('p', {}, esc(p.goal)),
    el('p', { class: 'muted' }, `Target rate ${esc(p.targetRate)} · ${esc(p.watch)}`),
    el('button', { class: 'btn ghost', style: 'margin-top:10px', onclick: profileSheet }, 'Edit profile')));

  root.append(el('div', { class: 'card' },
    el('h2', {}, 'Settings'),
    el('button', { class: 'btn ghost', onclick: apiKeySheet },
      settings.apiKey ? 'Anthropic API key ✓ (edit)' : 'Add Anthropic API key')));
}

/* ---------------- sheets ---------------- */
function logWeightSheet() {
  const input = el('input', { type: 'number', step: '0.1', inputmode: 'decimal', placeholder: 'e.g. 86.4' });
  const close = sheet('Log weight (kg)',
    el('div', { class: 'field' }, input),
    el('button', {
      class: 'btn', onclick: async () => {
        const kg = parseFloat(input.value);
        if (!kg || kg < 20 || kg > 400) return toast('That doesn’t look like a weight.');
        await logs.add('weights', { kg });
        close(); toast('Logged. Trend updates in Me.'); go('today');
      },
    }, 'Save'));
  input.focus();
}

function logMealSheet() {
  const input = el('input', { placeholder: 'What did you eat?' });
  let source = 'manual';
  const close = sheet('Log a meal',
    el('div', { class: 'field' }, input),
    el('div', { class: 'chips', style: 'margin-bottom:12px' },
      el('button', { class: 'chip on', onclick: e => { source = source === 'cookbook' ? 'manual' : 'cookbook'; e.target.classList.toggle('on'); } },
        'Home-cooked (from my cookbook)')),
    el('button', {
      class: 'btn', onclick: async () => {
        if (!input.value.trim()) return toast('Say what it was.');
        await logs.add('foods', { desc: input.value.trim(), source });
        close(); toast('Meal logged.'); go('today');
      },
    }, 'Save'));
  input.focus();
}

function logWorkoutSheet() {
  const input = el('input', { placeholder: 'e.g. Strength A, 5k easy run…' });
  const rpe = el('input', { type: 'number', min: 1, max: 10, inputmode: 'numeric', placeholder: 'RPE 1–10' });
  const close = sheet('Log a session',
    el('div', { class: 'field' }, el('label', {}, 'What was it?'), input),
    el('div', { class: 'field' }, el('label', {}, 'How hard did it feel?'), rpe),
    el('button', {
      class: 'btn', onclick: async () => {
        if (!input.value.trim()) return toast('Name the session.');
        await logs.add('workouts', { desc: input.value.trim(), rpe: parseInt(rpe.value) || null });
        close(); toast('Session logged. Vic sees it.'); go('today');
      },
    }, 'Save'));
  input.focus();
}

function apiKeySheet() {
  const input = el('input', { type: 'password', placeholder: 'sk-ant-…', autocomplete: 'off', value: settings.apiKey });
  const close = sheet('Anthropic API key',
    el('p', { class: 'muted', style: 'margin-bottom:12px' },
      'Stored only on this device and sent only to Anthropic — same as the cookbook. Get one at console.anthropic.com.'),
    el('div', { class: 'field' }, input),
    el('button', {
      class: 'btn', onclick: () => { settings.save({ apiKey: input.value.trim() }); close(); toast('Key saved.'); },
    }, 'Save key'));
  input.focus();
}

function profileSheet() {
  const p = { ...defaultProfile(), ...settings.profile };
  const injuries = el('input', { value: p.injuries, placeholder: 'e.g. left knee — no deep squats' });
  const equipment = el('input', { value: p.equipment, placeholder: 'e.g. dumbbells, bands, bike' });
  const tone = el('select', {},
    ...['gentle', 'balanced', 'direct'].map(t =>
      el('option', { value: t, selected: p.tone === t }, t[0].toUpperCase() + t.slice(1))));
  const close = sheet('Profile',
    el('div', { class: 'field' }, el('label', {}, 'Injuries / limits (Vic works around these)'), injuries),
    el('div', { class: 'field' }, el('label', {}, 'Equipment'), equipment),
    el('div', { class: 'field' }, el('label', {}, 'Vic’s tone dial'), tone),
    el('button', {
      class: 'btn', onclick: () => {
        settings.save({ profile: { ...p, injuries: injuries.value, equipment: equipment.value, tone: tone.value } });
        close(); toast('Saved. Vic adapts.'); go('me');
      },
    }, 'Save'));
}
