/* app.js — shell, tab router, and screens (see SPEC.md §8) */

import { $, el, esc, scoreRing, sheet, toast } from './ui.js';
import { settings, logs, defaultProfile } from './store.js';
import { weeklyScore, trendWeight, WEIGHTS } from './score.js';
import { askVic } from './vic.js';
import { generatePlan, activePlan, sessionForToday, latestMeasurement, latestBenchmark, daysSince } from './plan.js';
import { syncReady, signedIn, signUp, signIn, pushAll, pullAll, pushProfile, syncConfig, changePassword, restUpsert, restPatch, restGet } from './sync.js';
import { fetchRecipes, estimateNutrition, draftMealPlan, agreeMealPlan, currentMealPlan, downscaleImage, estimateMealFromPhoto } from './fuel.js';
import { stravaConfigured, stravaConnected, connectStrava, handleStravaRedirect, importActivities } from './strava.js';
import { initOnboarding, journeyActive, renderJourney, startJourney } from './onboarding.js';
import { vicAvatar } from './vic-avatar.js';
import { exerciseAnim } from './exercise-art.js';

const JOURNAL_TAGS = ['Late caffeine', 'Alcohol', 'Late meal', 'Screens in bed', 'Stretching', 'Cold shower', 'Reading in bed', 'Travel'];

const screens = { today, coach, train, fuel, me };
let chatHistory = []; // this session's Vic conversation (persisted turns go to IndexedDB)

function go(tab) {
  if (journeyActive()) { renderJourney(); return; } // sheets saved mid-journey refresh the journey
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('#screen').replaceChildren();
  screens[tab]($('#screen'));
  localStorage.setItem('trainer_tab', tab);
}

document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => go(b.dataset.tab)));

// first boot: start the calibration clock (SPEC §3.1)
if (!settings.profile.baselineStart) {
  settings.save({ profile: { ...defaultProfile(), ...settings.profile, baselineStart: new Date().toISOString().slice(0, 10) } });
}
// complete a Strava OAuth redirect if we arrived with ?code=
handleStravaRedirect().then(ok => { if (ok) toast('Strava connected.'); }).catch(e => toast('Strava: ' + e.message));

// the setup journey gates the app until its requirements are met (SPEC §8)
initOnboarding({
  sheets: {
    apiKey: apiKeySheet, cloud: cloudSheet, strava: stravaSheet,
    weight: logWeightSheet, tape: measurementSheet, bench: benchmarkSheet,
  },
  onDone: () => { toast('Welcome aboard. Vic’s watching.'); go('today'); },
});
if (!settings.load().onboardingDone) startJourney();
else go(localStorage.getItem('trainer_tab') || 'today');

/* Weekly Lifestyle Score history: upsert this week's score; lock the earliest row as
   the baseline once the calibration fortnight has passed (SPEC §3.1/§3.2). */
async function pushWeeklyScore(aggregate, pillars) {
  if (aggregate === null || !syncReady() || !signedIn()) return;
  const monday = (d => { d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.toISOString().slice(0, 10); })(new Date());
  try {
    await restUpsert('trainer_scores', [{ week_start: monday, aggregate, pillars }], 'user_id,week_start');
    const start = settings.profile.baselineStart;
    if (start && (Date.now() - Date.parse(start)) / 86400e3 >= 14) {
      const rows = await restGet('trainer_scores', 'select=id,week_start,is_baseline&order=week_start&limit=1');
      if (rows[0] && !rows[0].is_baseline) {
        const any = await restGet('trainer_scores', 'select=id&is_baseline=eq.true&limit=1');
        if (!any.length) await restPatch('trainer_scores', `id=eq.${rows[0].id}`, { is_baseline: true });
      }
    }
  } catch {}
}

/* ---------------- Today ---------------- */
async function today(root) {
  root.append(el('div', { class: 'hey-row' },
    el('div', {},
      el('h1', { class: 'hey' }, `Hey ${settings.profile.name}! 👋`),
      el('p', { class: 'hey-sub' }, todayGreeting())),
    vicAvatar(5)));

  // Lifestyle Score card
  const { aggregate, pillars } = await weeklyScore();
  const pillarRows = Object.entries(WEIGHTS).map(([key, { label }]) => {
    const v = pillars[key];
    return el('div', { class: 'pillar' },
      el('span', {}, label),
      el('span', { class: 'bar' }, el('i', { style: `width:${v ?? 0}%` })),
      el('span', { class: 'val' }, v === null ? '–' : String(v)));
  });
  pushWeeklyScore(aggregate, pillars);
  root.append(el('div', { class: 'card' },
    el('h2', {}, 'Lifestyle Score — this week'),
    el('div', { class: 'score-wrap' }, scoreRing(aggregate), el('div', { class: 'pillars' }, ...pillarRows)),
    aggregate === null
      ? el('p', { class: 'muted', style: 'margin-top:10px' },
          'Calibration in progress — log normally for two weeks to set your honest baseline. Vic explains why in the Coach tab.')
      : null));

  // Today's session (from the active plan)
  const plan = await activePlan();
  if (plan) {
    const t = sessionForToday(plan.plan);
    if (t.status === 'today') {
      root.append(el('div', { class: 'card' },
        el('h2', {}, `Today — week ${t.week.week}: ${t.week.theme}`),
        el('p', { style: 'font-weight:700;font-size:18px' }, t.session.title),
        el('p', { class: 'muted' }, `${t.session.type} · ${t.session.duration_min} min all-in`),
        el('button', { class: 'btn', style: 'margin-top:10px', onclick: () => player(t.session, t.week) }, 'Start session')));
    } else if (t.status === 'rest') {
      root.append(el('div', { class: 'card' },
        el('h2', {}, `Week ${t.week.week}: ${t.week.theme}`),
        el('p', {}, 'Rest day on the plan. Recovery is training too.')));
    }
  }

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
  return h < 12 ? 'Ready to crush today?' : h < 18 ? 'How’s the day tracking?' : 'Time for the evening review.';
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
        trySync();
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
  root.append(el('div', { class: 'hey-row', style: 'margin-bottom:8px' },
    el('div', {},
      el('h1', { class: 'hey' }, 'Vic'),
      el('p', { class: 'hey-sub', style: 'margin-bottom:0' }, '● AI Personal Trainer')),
    vicAvatar(5)));
  const chat = el('div', { class: 'chat' });
  root.append(chat);

  const stored = await logs.recent('chat', 2);
  for (const m of stored) bubble(chat, m.role === 'user' ? 'me' : 'vic', m.text);
  if (!stored.length) {
    bubble(chat, 'vic',
      'I’m Vic. One goal on the board: sustainable weight loss, measured properly. ' +
      'Step one is the measuring session — tape and benchmarks, Me tab. Then I build your plan: ' +
      'a theme for the month, a focus for each week, a workout for the day. No prescriptions before measurement. What’s on your mind?');
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

  const [meas, bench, plan] = await Promise.all([latestMeasurement(), latestBenchmark(), activePlan()]);

  // Gate 1: measure before prescription (SPEC §2.4/§3.4)
  if (!meas && !bench) {
    root.append(el('div', { class: 'card' },
      el('h2', {}, 'First: the measuring session'),
      el('p', {}, 'Vic doesn’t prescribe before he measures. Take your tape measurements and benchmarks in the Me tab — then the plan gets built from where you actually are.'),
      el('button', { class: 'btn', style: 'margin-top:10px', onclick: () => go('me') }, 'Go measure')));
    return;
  }

  // Gate 2: no plan yet → generate
  if (!plan) {
    const btn = el('button', { class: 'btn', style: 'margin-top:10px' }, 'Vic, build my plan');
    btn.addEventListener('click', async () => {
      if (!settings.apiKey) { apiKeySheet(); return; }
      btn.disabled = true; btn.textContent = 'Vic is planning… (~30s)';
      try {
        await generatePlan();
        toast('Plan ready.');
        trySync();
        go('train');
      } catch (e) {
        btn.disabled = false; btn.textContent = 'Vic, build my plan';
        toast(e.message === 'NO_BASELINE' ? 'Measure first — Me tab.' : e.message);
      }
    });
    root.append(el('div', { class: 'card' },
      el('h2', {}, 'Ready to plan'),
      el('p', {}, 'Measurements are in. Vic will write a 4-week block: a monthly theme, a focus per week (week 4 deloads), and workouts of the day built from your equipment within your session budget.'),
      btn));
    return;
  }

  // Active plan view: month theme → weekly focus → WOD
  const p = plan.plan;
  const t = sessionForToday(p);
  root.append(el('div', { class: 'card' },
    el('h2', {}, 'This month'),
    el('p', { style: 'font-weight:700;font-size:18px' }, p.month_theme),
    p.rationale ? el('p', { class: 'muted', style: 'margin-top:6px' }, p.rationale) : null,
    el('p', { class: 'muted', style: 'margin-top:6px' }, `Started ${p.start_date}`)));

  if (t.status === 'today') {
    root.append(wodCard(t.week, t.session, true));
  } else if (t.status === 'rest') {
    root.append(el('div', { class: 'card' },
      el('h2', {}, `Week ${t.week.week} — ${t.week.theme}`),
      el('p', {}, t.next ? `Rest day. Next up: ${t.next.title}.` : 'Rest day — the week is done. Recovery is training too.')));
  } else if (t.status === 'starts') {
    root.append(el('div', { class: 'card' }, el('h2', {}, 'Starts soon'),
      el('p', {}, `The block begins ${t.when}. Week 1: ${t.week.theme}`)));
  } else {
    root.append(el('div', { class: 'card' }, el('h2', {}, 'Block complete'),
      el('p', {}, 'Four weeks done — time to re-measure, re-benchmark (Me tab) and let Vic write the next block.')));
  }

  // Full week outline
  if (t.week) {
    root.append(el('div', { class: 'card' },
      el('h2', {}, `Week ${t.week.week} outline`),
      ...(t.week.sessions || []).map(s => el('p', { style: 'margin:4px 0' },
        `${['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][s.dow]} — ${s.title} (${s.duration_min} min)`))));
  }

  root.append(el('button', {
    class: 'btn ghost', onclick: async () => {
      if (!confirm('Replace the current plan with a freshly generated block?')) return;
      go('train');
    },
  }, 'Plan options'), el('p', { class: 'muted', style: 'margin-top:8px' },
    'To re-plan, re-measure in Me first — Vic rebuilds from fresh numbers after each block.'));
}

function wodCard(week, session, startable) {
  return el('div', { class: 'card' },
    el('h2', {}, `Today · week ${week.week} — ${week.theme}`),
    el('p', { style: 'font-weight:700;font-size:18px' }, session.title),
    el('p', { class: 'muted' }, `${session.type} · ${session.duration_min} min including warm-up & cool-down`),
    ...(session.blocks || []).map(b => el('p', { class: 'muted', style: 'margin-top:4px' },
      `${b.name} (${b.minutes} min): ${(b.exercises || []).map(x => x.name).join(', ')}`)),
    startable ? el('button', { class: 'btn', style: 'margin-top:10px', onclick: () => player(session, week) }, 'Start session') : null);
}

/* ---------------- Workout player ---------------- */
function player(session, week) {
  const root = $('#screen');
  root.replaceChildren();
  root.append(el('h1', { class: 'h-page' }, session.title),
    el('p', { class: 'muted', style: 'margin-top:-10px;margin-bottom:14px' },
      `Week ${week.week} — ${week.theme} · budget ${session.duration_min} min`));

  for (const block of (session.blocks || [])) {
    const card = el('div', { class: 'card' }, el('h2', {}, `${block.name} · ${block.minutes} min`));
    for (const ex of (block.exercises || [])) {
      const sets = Math.max(1, ex.sets || 1);
      const chips = Array.from({ length: sets }, (_, i) => el('button', {
        class: 'chip', onclick: e => e.target.classList.toggle('on'),
      }, `Set ${i + 1}`));
      card.append(el('div', { style: 'margin:10px 0 4px' },
        el('div', { class: 'row' },
          exerciseAnim(ex.name, 2.6),
          el('b', { class: 'grow' }, ex.name),
          el('span', { class: 'muted' }, ex.reps ? `${sets}×${ex.reps}` : '')),
        el('p', { class: 'muted', style: 'font-size:13px' },
          [ex.equipment, ex.note].filter(Boolean).join(' · ')),
        el('div', { class: 'chips', style: 'margin-top:6px' }, ...chips,
          ex.rest_sec ? restButton(ex.rest_sec) : null)));
    }
    root.append(card);
  }

  root.append(el('button', {
    class: 'btn', style: 'width:100%', onclick: () => finishSheet(session),
  }, 'Finish session'), el('button', {
    class: 'btn ghost', style: 'width:100%;margin-top:8px', onclick: () => go('train'),
  }, 'Back (nothing saved)'));
}

function restButton(sec) {
  const btn = el('button', { class: 'chip' }, `⏱ Rest ${sec}s`);
  let timer = null;
  btn.addEventListener('click', () => {
    if (timer) { clearInterval(timer); timer = null; btn.textContent = `⏱ Rest ${sec}s`; return; }
    let left = sec;
    btn.classList.add('on');
    timer = setInterval(() => {
      left -= 1;
      btn.textContent = `⏱ ${left}s`;
      if (left <= 0) {
        clearInterval(timer); timer = null;
        btn.classList.remove('on');
        btn.textContent = `⏱ Rest ${sec}s`;
        beep();
      }
    }, 1000);
  });
  return btn;
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880; g.gain.value = 0.15;
    o.start(); o.stop(ctx.currentTime + 0.35);
  } catch {}
  if (navigator.vibrate) navigator.vibrate(200);
}

function finishSheet(session) {
  const rpe = ratingRow10();
  const close = sheet('How hard was that?',
    rpe.row,
    el('button', {
      class: 'btn', style: 'margin-top:12px', onclick: async () => {
        await logs.add('workouts', { desc: session.title, rpe: rpe.value(), planned: true, detail: { type: session.type } });
        close(); toast('Session logged. Vic sees it.');
        trySync();
        go('today');
      },
    }, 'Save session'));
}

function ratingRow10() {
  let val = 6;
  const btns = Array.from({ length: 10 }, (_, i) => i + 1).map(n => el('button', {
    class: 'chip' + (n === 6 ? ' on' : ''),
    onclick: e => {
      val = n;
      [...e.target.parentNode.children].forEach(c => c.classList.remove('on'));
      e.target.classList.add('on');
    },
  }, String(n)));
  return { row: el('div', { class: 'chips' }, ...btns), value: () => val };
}

/* ---------------- Fuel ---------------- */
async function fuel(root) {
  root.append(el('h1', { class: 'h-page' }, 'Fuel'));

  const foods = await logs.recent('foods', 7);
  const todayKcal = foods.filter(f => f.ts.slice(0, 10) === new Date().toISOString().slice(0, 10))
    .reduce((a, f) => a + (f.kcal || 0), 0);
  root.append(el('div', { class: 'card' },
    el('h2', {}, 'This week'),
    el('p', {}, `${foods.length} meal${foods.length === 1 ? '' : 's'} logged` +
      (todayKcal ? ` · ~${todayKcal} kcal today` : '')),
    el('div', { class: 'chips', style: 'margin-top:10px' },
      el('button', { class: 'chip', onclick: photoLogSheet }, '📸 Photo log'),
      el('button', { class: 'chip', onclick: () => logMealSheet() }, '✏️ Log a meal'))));

  // This week's meal plan (SPEC §5.2): draft -> agree -> pushed to the cookbook
  const plan = await currentMealPlan();
  const planCard = el('div', { class: 'card' }, el('h2', {}, 'Meal plan — this week'));
  if (plan) {
    for (const d of plan.days) {
      planCard.append(el('p', { style: 'margin:3px 0' },
        el('b', {}, d.day + ': '), `${d.meal}${d.kcal ? ` · ~${d.kcal} kcal` : ''}`));
    }
    planCard.append(el('p', { class: 'muted', style: 'margin-top:6px' },
      'Agreed — it’s in the cookbook with the shopping list.'));
  } else {
    const btn = el('button', { class: 'btn', style: 'margin-top:6px' }, 'Vic, draft this week');
    btn.addEventListener('click', async () => {
      if (!settings.apiKey) { apiKeySheet(); return; }
      btn.disabled = true; btn.textContent = 'Vic is planning…';
      try { mealPlanDraftSheet(await draftMealPlan()); }
      catch (e) { toast(e.message === 'NO_KEY' ? 'Add your API key first.' : e.message); }
      btn.disabled = false; btn.textContent = 'Vic, draft this week';
    });
    planCard.append(el('p', { class: 'muted' },
      'Vic drafts dinners from your cookbook recipes and live pantry, macro-matched to training days. You agree it before anything syncs.'), btn);
  }
  root.append(planCard);

  // Cookbook recipes (shared_recipes)
  const recCard = el('div', { class: 'card' }, el('h2', {}, 'My cookbook recipes'));
  if (!signedIn()) {
    recCard.append(el('p', { class: 'muted' }, 'Sign in to cloud sync (Me → Settings) to see recipes synced from the cookbook.'));
  } else {
    try {
      const recipes = await fetchRecipes();
      if (!recipes.length) {
        recCard.append(el('p', { class: 'muted' }, 'No recipes synced yet — run a sync from the cookbook app.'));
      }
      for (const r of recipes.slice(0, 12)) {
        const row = el('div', { class: 'row', style: 'margin:6px 0' },
          el('span', { class: 'grow' }, r.title,
            r.nutrition ? el('span', { class: 'muted' }, ` · ${r.nutrition.kcal} kcal/serv`) : ''));
        if (r.nutrition) {
          row.append(el('button', {
            class: 'chip', onclick: async () => {
              await logs.add('foods', { desc: r.title, source: 'cookbook', recipeId: r.id,
                kcal: r.nutrition.kcal, protein: r.nutrition.protein_g, carbs: r.nutrition.carbs_g, fat: r.nutrition.fat_g });
              toast('Logged a serving.'); trySync(); go('fuel');
            },
          }, 'Cooked this'));
        } else {
          row.append(el('button', {
            class: 'chip', onclick: async e => {
              e.target.textContent = 'Estimating…'; e.target.disabled = true;
              try { await estimateNutrition(r.id); go('fuel'); }
              catch (err) { toast(err.message); e.target.textContent = 'Estimate'; e.target.disabled = false; }
            },
          }, 'Estimate'));
        }
        recCard.append(row);
      }
    } catch (e) {
      recCard.append(el('p', { class: 'muted' }, '⚠️ ' + e.message));
    }
  }
  root.append(recCard);
}

function mealPlanDraftSheet(draft) {
  const close = sheet('Vic’s draft — agree it?',
    ...draft.days.map(d => el('p', { style: 'margin:4px 0' },
      el('b', {}, d.day + ': '), `${d.meal}${d.kcal ? ` · ~${d.kcal} kcal` : ''}`)),
    el('p', { class: 'muted', style: 'margin-top:8px' },
      `Shopping list: ${(draft.shopping || []).length} items (pantry already excluded).`),
    el('div', { class: 'chips', style: 'margin-top:10px' },
      el('button', {
        class: 'btn', onclick: async () => {
          try {
            const r = await agreeMealPlan(draft);
            close(); toast(r.pushed ? `Agreed — sent to the cookbook (${r.items} shopping items).` : 'Agreed — saved locally (sign in to push to the cookbook).');
            go('fuel');
          } catch (e) { toast(e.message); }
        },
      }, 'Agree ✓'),
      el('button', { class: 'chip', onclick: () => { close(); toast('Draft discarded — ask Vic again anytime.'); } }, 'Discard')));
}

function photoLogSheet() {
  const input = el('input', { type: 'file', accept: 'image/*', capture: 'environment' });
  const status = el('p', { class: 'muted', style: 'margin-top:8px' }, 'Snap the plate — Claude estimates portions and macros; you confirm.');
  const close = sheet('Photo log',
    el('div', { class: 'field' }, input), status);
  input.addEventListener('change', async () => {
    if (!input.files?.[0]) return;
    if (!settings.apiKey) { close(); apiKeySheet(); return; }
    status.textContent = 'Estimating…';
    try {
      const est = await estimateMealFromPhoto(await downscaleImage(input.files[0]));
      close();
      const desc = el('input', { value: est.desc || '' });
      const kcal = el('input', { type: 'number', value: est.kcal ?? '' });
      const close2 = sheet('Confirm meal',
        el('div', { class: 'field' }, el('label', {}, 'What is it?'), desc),
        el('div', { class: 'field' }, el('label', {}, `kcal (protein ${est.protein_g}g · carbs ${est.carbs_g}g · fat ${est.fat_g}g · confidence ${est.confidence})`), kcal),
        el('button', {
          class: 'btn', onclick: async () => {
            await logs.add('foods', { desc: desc.value.trim() || 'Meal (photo)', source: 'photo',
              kcal: parseInt(kcal.value) || null, protein: est.protein_g, carbs: est.carbs_g, fat: est.fat_g });
            close2(); toast('Meal logged.'); trySync(); go('fuel');
          },
        }, 'Log it'));
    } catch (e) { status.textContent = '⚠️ ' + e.message; }
  });
}

/* ---------------- Me ---------------- */
async function me(root) {
  root.append(el('h1', { class: 'h-page' }, 'Me'));
  const [weights, meas, bench] = await Promise.all([
    logs.recent('weights', 28), latestMeasurement(), latestBenchmark(),
  ]);
  const trend = trendWeight(weights);
  root.append(el('div', { class: 'card' },
    el('h2', {}, 'Trend weight (7-day EMA)'),
    el('p', { style: 'font-size:28px;font-weight:700' }, trend ? `${trend.toFixed(1)} kg` : 'No entries yet'),
    el('p', { class: 'muted' }, 'The trend is the headline — never the daily spike.'),
    el('button', { class: 'btn ghost', style: 'margin-top:10px', onclick: logWeightSheet }, 'Log weight')));

  // Measurements & benchmarks (SPEC §3.4: tape 4-weekly, benchmarks 8-weekly)
  const measDue = !meas || daysSince(meas) >= 28;
  const benchDue = !bench || daysSince(bench) >= 56;
  root.append(el('div', { class: 'card' },
    el('h2', {}, 'Measurements & benchmarks'),
    meas
      ? el('p', {}, `Tape: waist ${meas.waist ?? '–'} · hips ${meas.hips ?? '–'} · chest ${meas.chest ?? '–'} cm (${daysSince(meas)}d ago)`)
      : el('p', { class: 'muted' }, 'No tape measurements yet — this gates your first plan.'),
    bench
      ? el('p', {}, `Benchmarks: ${bench.pushups ?? '–'} push-ups · plank ${bench.plankSec ?? '–'}s · 1.6 km ${bench.runSec ? fmtMinSec(bench.runSec) : '–'} (${daysSince(bench)}d ago)`)
      : el('p', { class: 'muted' }, 'No fitness/strength benchmarks yet.'),
    (measDue || benchDue) ? el('p', { class: 'did-you-know' },
      measDue && benchDue ? 'Measuring session due — tape and benchmarks.' :
      measDue ? 'Tape measurements due (4-weekly).' : 'Benchmarks due (8-weekly).') : null,
    el('div', { class: 'chips', style: 'margin-top:10px' },
      el('button', { class: 'chip', onclick: measurementSheet }, '📏 Log tape measurements'),
      el('button', { class: 'chip', onclick: benchmarkSheet }, '⏱ Log benchmarks'))));

  const p = settings.profile;
  root.append(el('div', { class: 'card' },
    el('h2', {}, 'Profile & goal'),
    el('p', {}, esc(p.goal)),
    el('p', { class: 'muted' }, `Target rate ${esc(p.targetRate)} · ${esc(p.watch)} · ${p.sessionMinutes} min sessions`),
    el('p', { class: 'muted', style: 'margin-top:4px' }, `Kit: ${esc(p.equipment)}`),
    el('button', { class: 'btn ghost', style: 'margin-top:10px', onclick: profileSheet }, 'Edit profile')));

  root.append(el('div', { class: 'card' },
    el('h2', {}, 'Settings'),
    el('div', { class: 'chips' },
      el('button', { class: 'chip', onclick: apiKeySheet },
        settings.apiKey ? 'Anthropic API key ✓' : 'Add Anthropic API key'),
      el('button', { class: 'chip', onclick: cloudSheet },
        signedIn() ? 'Cloud sync ✓' : 'Set up cloud sync'),
      el('button', { class: 'chip', onclick: stravaSheet },
        stravaConnected() ? 'Strava ✓' : 'Connect Strava'),
      el('button', { class: 'chip', onclick: metricsSheet }, '⌚ Garmin day log'),
      el('button', { class: 'chip', onclick: () => startJourney() }, '🚀 Replay setup journey'))));
}

const fmtMinSec = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

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
        close(); toast('Logged. Trend updates in Me.'); trySync(); go('today');
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
        close(); toast('Meal logged.'); trySync(); go('today');
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
        close(); toast('Session logged. Vic sees it.'); trySync(); go('today');
      },
    }, 'Save'));
  input.focus();
}

function numField(label, placeholder, attrs = {}) {
  const input = el('input', { type: 'number', inputmode: 'decimal', step: '0.1', placeholder, ...attrs });
  return { row: el('div', { class: 'field' }, el('label', {}, label), input), value: () => parseFloat(input.value) || null };
}

function measurementSheet() {
  const f = {
    waist: numField('Waist (cm) — at the navel, relaxed', 'e.g. 94.5'),
    hips: numField('Hips (cm) — widest point', 'e.g. 104'),
    chest: numField('Chest (cm) — nipple line', 'e.g. 102'),
    arm: numField('Upper arm (cm) — flexed, widest', 'e.g. 34'),
    thigh: numField('Thigh (cm) — widest point', 'e.g. 58'),
  };
  const close = sheet('Tape measurements',
    el('p', { class: 'muted', style: 'margin-bottom:12px' },
      'Same tape, same spots, same time of day (morning is best). Every 4 weeks.'),
    ...Object.values(f).map(x => x.row),
    el('button', {
      class: 'btn', onclick: async () => {
        const vals = Object.fromEntries(Object.entries(f).map(([k, x]) => [k, x.value()]));
        if (!Object.values(vals).some(v => v)) return toast('At least one measurement, champ.');
        await logs.add('measurements', vals);
        close(); toast('Measurements saved.'); trySync(); go('me');
      },
    }, 'Save measurements'));
}

function benchmarkSheet() {
  const hr = numField('Resting heart rate (bpm) — morning, before coffee', 'e.g. 62', { step: '1' });
  const runM = numField('1.6 km run — minutes', 'e.g. 9', { step: '1' });
  const runS = numField('…and seconds', 'e.g. 30', { step: '1' });
  const push = numField('Push-ups — max unbroken', 'e.g. 18', { step: '1' });
  const plank = numField('Plank hold (seconds)', 'e.g. 60', { step: '1' });
  const sqReps = numField('Goblet squat — reps', 'e.g. 15', { step: '1' });
  const sqKg = numField('…with dumbbell (kg)', 'e.g. 10');
  const close = sheet('Fitness & strength benchmarks',
    el('p', { class: 'muted', style: 'margin-bottom:12px' },
      'Every 8 weeks, same conditions. Warm up first; run route should be repeatable.'),
    hr.row, runM.row, runS.row, push.row, plank.row, sqReps.row, sqKg.row,
    el('button', {
      class: 'btn', onclick: async () => {
        const runSec = (runM.value() || 0) * 60 + (runS.value() || 0);
        await logs.add('benchmarks', {
          restingHr: hr.value(), runSec: runSec || null, pushups: push.value(),
          plankSec: plank.value(), squatReps: sqReps.value(), squatKg: sqKg.value(),
        });
        close(); toast('Benchmarks saved.'); trySync(); go('me');
      },
    }, 'Save benchmarks'));
}

function apiKeySheet() {
  const input = el('input', { type: 'password', placeholder: 'sk-ant-…', autocomplete: 'off', value: settings.apiKey });
  const close = sheet('Anthropic API key',
    el('p', { class: 'muted', style: 'margin-bottom:12px' },
      'Stored only on this device and sent only to Anthropic — same as the cookbook. Get one at console.anthropic.com.'),
    el('div', { class: 'field' }, input),
    el('button', {
      class: 'btn', onclick: () => {
        settings.save({ apiKey: input.value.trim() });
        close(); toast('Key saved.');
        if (journeyActive()) renderJourney();
      },
    }, 'Save key'));
  input.focus();
}

function cloudSheet() {
  const s = settings.load();
  const cfg = syncConfig();
  const url = el('input', { placeholder: 'https://xxxx.supabase.co', value: cfg.url });
  const key = el('input', { type: 'password', placeholder: 'anon / publishable key', value: cfg.anonKey });
  const email = el('input', { type: 'email', placeholder: 'you@example.com', value: s.syncEmail || 'aphilem@gmail.com' });
  const pass = el('input', { type: 'password', placeholder: 'password (min 6 chars)' });
  const status = el('p', { class: 'muted', style: 'margin-top:10px' },
    signedIn() ? `Signed in. Last sync: ${s.lastSync ? s.lastSync.slice(0, 16).replace('T', ' ') : 'never'}` : 'Not signed in.');
  const doAuth = fn => async () => {
    settings.save({ supabaseUrl: url.value.trim(), supabaseAnonKey: key.value.trim(), syncEmail: email.value.trim() });
    if (!syncReady()) return toast('Project URL and key first.');
    if (!pass.value) return toast('Enter your password first.');
    try {
      await fn(email.value.trim(), pass.value);
      if (!signedIn()) {
        // Signup without a session: the email either already has an account in this
        // project or needs confirmation — either way, Sign in is the next step.
        status.textContent = 'No session yet. If this email already has an account here, tap Sign in with its password. Otherwise check your inbox for a confirmation link, then Sign in.';
        return;
      }
      status.textContent = 'Signed in ✓ — syncing…';
      const counts = await pushAll(); await pushProfile();
      status.textContent = 'Synced: ' + (Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ') || 'nothing new');
      toast('Cloud sync on.');
      if (journeyActive()) renderJourney();
    } catch (e) {
      status.textContent = '⚠️ ' + (e.message === 'NOT_SIGNED_IN' ? 'Not signed in yet — tap Sign in with your password.' : e.message);
    }
  };
  sheet('Cloud sync (Supabase)',
    el('p', { class: 'muted', style: 'margin-bottom:12px' },
      'Backs up your logs to your own Supabase project and syncs web ↔ Android. Fill these once — the values live only on this device.'),
    el('div', { class: 'field' }, el('label', {}, 'Project URL'), url),
    el('div', { class: 'field' }, el('label', {}, 'Publishable (anon) key'), key),
    el('div', { class: 'field' }, el('label', {}, 'Email'), email),
    el('div', { class: 'field' }, el('label', {}, 'Password'), pass),
    el('div', { class: 'chips' },
      el('button', { class: 'chip', onclick: doAuth(signUp) }, 'Create account'),
      el('button', { class: 'chip', onclick: doAuth(signIn) }, 'Sign in'),
      el('button', {
        class: 'chip', onclick: async () => {
          if (!signedIn()) return toast('Sign in first.');
          if (!pass.value || pass.value.length < 8) return toast('Type a NEW password (8+ chars) in the password field first.');
          try { await changePassword(pass.value); status.textContent = 'Password changed ✓'; pass.value = ''; }
          catch (e) { status.textContent = '⚠️ ' + e.message; }
        },
      }, 'Change password'),
      el('button', {
        class: 'chip', onclick: async () => {
          if (!signedIn()) return toast('Sign in first.');
          status.textContent = 'Restoring…';
          try {
            const counts = await pullAll();
            const total = Object.values(counts).reduce((a, b) => a + b, 0);
            status.textContent = total ? `Restored ${total} entries from the cloud.` : 'Nothing to restore — local data already present.';
          } catch (e) { status.textContent = '⚠️ ' + e.message; }
        },
      }, 'Restore from cloud'),
      el('button', {
        class: 'chip', onclick: async () => {
          try {
            const counts = await pushAll();
            status.textContent = 'Synced: ' + (Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ') || 'nothing new');
          } catch (e) {
            status.textContent = '⚠️ ' + (e.message === 'NOT_SIGNED_IN' ? 'Sign in first.' : e.message);
          }
        },
      }, 'Sync now')),
    status);
}

/* Fire-and-forget push after any log write; silent when sync isn't set up */
function trySync() {
  if (syncReady() && signedIn()) pushAll().catch(() => {});
}

function metricsSheet() {
  const f = {
    sleepScore: numField('Sleep score (0–100, from Garmin Connect)', 'e.g. 78', { step: '1' }),
    restingHr: numField('Resting HR (bpm)', 'e.g. 62', { step: '1' }),
    stress: numField('Avg stress (0–100)', 'e.g. 32', { step: '1' }),
    bodyBattery: numField('Body Battery high', 'e.g. 85', { step: '1' }),
    steps: numField('Steps', 'e.g. 9500', { step: '1' }),
  };
  const close = sheet('Garmin day log',
    el('p', { class: 'muted', style: 'margin-bottom:12px' },
      'Copy today’s numbers from Garmin Connect (30 seconds). Automatic Health Connect sync replaces this once the Android build ships — see BACKLOG.md.'),
    ...Object.values(f).map(x => x.row),
    el('button', {
      class: 'btn', onclick: async () => {
        const vals = Object.fromEntries(Object.entries(f).map(([k, x]) => [k, x.value()]));
        if (!Object.values(vals).some(v => v)) return toast('At least one number.');
        await logs.add('metrics', vals);
        close(); toast('Day logged. Recover pillar sees it.'); trySync(); go('me');
      },
    }, 'Save'));
}

function stravaSheet() {
  const s = settings.load();
  const id = el('input', { value: s.stravaClientId || '', placeholder: 'Client ID', inputmode: 'numeric' });
  const secret = el('input', { type: 'password', value: s.stravaClientSecret || '', placeholder: 'Client secret' });
  const status = el('p', { class: 'muted', style: 'margin-top:10px' },
    stravaConnected() ? 'Connected ✓' : 'Not connected.');
  sheet('Strava',
    el('p', { class: 'muted', style: 'margin-bottom:12px' },
      'Create your own (free) API app at strava.com/settings/api — set Authorization Callback Domain to aphile-m.github.io — then paste its credentials here. They stay on this device.'),
    el('div', { class: 'field' }, el('label', {}, 'Client ID'), id),
    el('div', { class: 'field' }, el('label', {}, 'Client secret'), secret),
    el('div', { class: 'chips' },
      el('button', {
        class: 'chip', onclick: () => {
          settings.save({ stravaClientId: id.value.trim(), stravaClientSecret: secret.value.trim() });
          if (!stravaConfigured()) return toast('Both fields first.');
          connectStrava();
        },
      }, stravaConnected() ? 'Reconnect' : 'Connect Strava'),
      el('button', {
        class: 'chip', onclick: async e => {
          if (!stravaConnected()) return toast('Connect first.');
          e.target.textContent = 'Importing…';
          try {
            const n = await importActivities();
            status.textContent = n ? `Imported ${n} new activit${n === 1 ? 'y' : 'ies'} ✓` : 'Nothing new to import.';
            trySync();
          } catch (err) { status.textContent = '⚠️ ' + err.message; }
          e.target.textContent = 'Import activities';
        },
      }, 'Import activities')),
    status);
}

function profileSheet() {
  const p = { ...defaultProfile(), ...settings.profile };
  const injuries = el('input', { value: p.injuries, placeholder: 'e.g. left knee — no deep squats' });
  const equipment = el('input', { value: p.equipment });
  const minutes = el('input', { type: 'number', value: p.sessionMinutes, min: 15, max: 180, step: 5 });
  const tone = el('select', {},
    ...['gentle', 'balanced', 'direct'].map(t =>
      el('option', { value: t, selected: p.tone === t }, t[0].toUpperCase() + t.slice(1))));
  const close = sheet('Profile',
    el('div', { class: 'field' }, el('label', {}, 'Injuries / limits (Vic works around these)'), injuries),
    el('div', { class: 'field' }, el('label', {}, 'Equipment (drives every plan)'), equipment),
    el('div', { class: 'field' }, el('label', {}, 'Session budget (min, incl. warm-up & cool-down)'), minutes),
    el('div', { class: 'field' }, el('label', {}, 'Vic’s tone dial'), tone),
    el('button', {
      class: 'btn', onclick: () => {
        settings.save({
          profile: {
            ...p, injuries: injuries.value, equipment: equipment.value,
            sessionMinutes: parseInt(minutes.value) || 60, tone: tone.value,
          },
        });
        close(); toast('Saved. Vic adapts.'); pushProfile(); go('me');
      },
    }, 'Save'));
}
