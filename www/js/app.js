/* app.js — shell, tab router, and screens (see SPEC.md §8) */

import { $, el, esc, scoreRing, sheet, toast } from './ui.js';
import { settings, logs, defaultProfile } from './store.js';
import { weeklyScore, scoreDetail, trendWeight, WEIGHTS } from './score.js';
import { askVic, vicBriefing } from './vic.js';
import { generatePlan, activePlan, sessionForToday, latestMeasurement, latestBenchmark, daysSince } from './plan.js';
import { syncReady, signedIn, signUp, signIn, pushAll, pullAll, pushProfile, adoptCloudSetup, syncConfig, changePassword, restUpsert, restPatch, restGet } from './sync.js';
import { fetchRecipes, estimateNutrition, draftMealPlan, agreeMealPlan, currentMealPlan, downscaleImage, estimateMealFromPhoto } from './fuel.js';
import { stravaConfigured, stravaConnected, connectStrava, handleStravaRedirect, completePendingStrava, importActivities, stravaLastImport } from './strava.js';
import { initOnboarding, journeyActive, renderJourney, startJourney, completeJourney } from './onboarding.js';
import { vicAvatar } from './vic-avatar.js';
import { vicSprite } from './vic-sprite.js';
import { exerciseAnim } from './exercise-art.js';

const JOURNAL_TAGS = ['Late caffeine', 'Alcohol', 'Late meal', 'Screens in bed', 'Stretching', 'Cold shower', 'Reading in bed', 'Travel'];
const WEB_VERSION = 39; // bump together with CACHE in sw.js AND the ship date below
const WEB_SHIPPED = '26 Jul 2026';

const screens = { today, coach, train, fuel, me };
let chatHistory = []; // this session's Vic conversation (persisted turns go to IndexedDB)
let coachPrefill = null; // question handed to the coach screen by other screens
let vicThinking = false; // a reply is in flight — survives leaving the screen
let onVicUpdate = null; // active screen's refresh hook; must return true if it rendered
let planJob = null, planJobStart = 0; // in-flight plan generation (singleton)
let mealJob = null, mealJobStart = 0, mealDraft = null; // in-flight meal-plan draft

function go(tab, fromPop = false) {
  if (journeyActive()) { renderJourney(); return; } // sheets saved mid-journey refresh the journey
  if (!fromPop) {
    // every screen is a history entry so the Android back button navigates
    // instead of closing the app; at the root, back exits as expected
    if (!go._init) history.replaceState({ tab }, '');
    else if (history.state?.tab !== tab || history.state?.player) history.pushState({ tab }, '');
    go._init = true;
  }
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('#screen').replaceChildren();
  screens[tab]($('#screen'));
  localStorage.setItem('trainer_tab', tab);
}

window.addEventListener('popstate', e => {
  if (journeyActive()) return; // the journey handles its own pages
  if (e.state && e.state.tab) go(e.state.tab, true);
});

/* Log sheets can be opened from anywhere (incl. Vic's in-chat buttons) — after
   saving, land back on the tab the user was on, not the sheet's home tab. */
const goCurrent = fallback => go(localStorage.getItem('trainer_tab') || fallback);

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
(async function boot() {
  if (!settings.load().onboardingDone) {
    // Returning user in a fresh browser: restore from the cloud first, then skip
    // the journey automatically when its requirements are already met in reality.
    try {
      if (signedIn() && !(await logs.all('weights')).length) await pullAll();
    } catch {}
    const [meas, bench, weights] = await Promise.all([
      latestMeasurement(), latestBenchmark(), logs.all('weights'),
    ]);
    if (settings.apiKey && weights.length && meas && bench) {
      settings.save({ onboardingDone: true, profileConfirmed: true });
    }
  }
  if (!settings.load().onboardingDone) startJourney();
  else {
    go(localStorage.getItem('trainer_tab') || 'today');
    autoCloudPush();
    autoStravaSync();
    checkNativeUpdate();
    resumeVicIfDangling(); // finish a reply that died with the previous page
  }
})();

/* The Android shell resumes this same page for days when reopened from recents,
   so freshly deployed web updates never arrived without a force-close. Reload on
   resume once the loaded build is stale — but never mid-workout, over an open
   sheet, or during the setup journey. */
const loadedAt = Date.now();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const stale = Date.now() - loadedAt > 30 * 60e3;
  const busy = vicThinking || planJob || mealJob || history.state?.player ||
    document.querySelector('#overlay-root .overlay') || journeyActive();
  if (stale && !busy) location.reload();
  else resumeVicIfDangling(); // heal a reply the OS killed while backgrounded
});

/* Android shell: web updates arrive live (the shell loads the hosted app), but
   the APK itself is versioned — check the latest release at launch and offer it. */
async function checkNativeUpdate() {
  const cap = window.Capacitor;
  if (!cap || !(cap.isNativePlatform && cap.isNativePlatform())) return;
  try {
    const info = await cap.Plugins.App.getInfo();
    const mine = parseInt(info.build) || parseInt(info.version) || 0;
    const rel = await (await fetch('https://api.github.com/repos/aphile-m/Lifestyle-App/releases/latest')).json();
    const latest = parseInt(String(rel.tag_name || '').replace('android-v', '')) || 0;
    if (latest > mine) {
      toast(`📦 App update v${latest} available (you have v${mine})`);
      if (confirm(`Trainer App v${latest} is out (you have v${mine}). Download the update now? It installs over the current app — your data stays.`)) {
        window.open('https://github.com/aphile-m/Lifestyle-App/releases/latest/download/Trainer-App.apk', '_blank');
      }
    }
  } catch {}
}

/* Push any unsynced local logs on every launch — logs made before sign-in
   used to sit on-device forever waiting for the next manual save. */
async function autoCloudPush() {
  if (!signedIn()) return;
  try {
    await pushProfile(); // keep the cloud mirror of setup (incl. Strava tokens) current
    const counts = await pushAll();
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total > 0) toast(`☁️ ${total} entr${total === 1 ? 'y' : 'ies'} backed up`);
  } catch (e) {
    // surface what failed — silent sync failures hid missing measurements once already
    const total = e.counts ? Object.values(e.counts).reduce((a, b) => a + b, 0) : 0;
    toast(`☁️ ${total ? total + ' backed up · ' : ''}⚠️ ${e.message.slice(0, 180)}`);
  }
}

/* Strava syncs itself on every launch; quiet unless something new arrived. */
async function autoStravaSync() {
  if (!signedIn()) return;
  if (!stravaConnected()) {
    // OAuth completes in the external browser on Android — the connection reaches
    // this context through the cloud setup mirror, so adopt it at launch.
    try { await adoptCloudSetup(); } catch {}
    if (stravaConnected()) { toast('🏃 Strava connected via your account ✓'); go(localStorage.getItem('trainer_tab') || 'today'); }
  }
  if (!stravaConnected()) return;
  try {
    const n = await importActivities();
    if (n > 0) {
      toast(`🏃 ${n} new activit${n === 1 ? 'y' : 'ies'} from Strava`);
      trySync();
      if ((localStorage.getItem('trainer_tab') || 'today') === 'today' && !journeyActive()) go('today');
    }
  } catch {} // silent — the Today card shows staleness, manual sync shows errors
}

function timeAgo(iso) {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

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
    vicSprite(84)));

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
      : null,
    el('button', { class: 'btn ghost', style: 'margin-top:12px', onclick: insightsScreen },
      '📊 Score insights')));

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

  // Strava status (sync runs at launch; manual sync + freshness here)
  if (stravaConnected()) {
    const last = stravaLastImport();
    const syncBtn = el('button', { class: 'chip' }, '↻ Sync');
    syncBtn.addEventListener('click', async () => {
      syncBtn.disabled = true; syncBtn.textContent = 'Syncing…';
      try {
        const n = await importActivities();
        toast(n ? `🏃 ${n} new activit${n === 1 ? 'y' : 'ies'} imported` : 'Up to date — nothing new on Strava.');
        trySync(); go('today');
      } catch (e) { toast('Strava: ' + e.message); syncBtn.disabled = false; syncBtn.textContent = '↻ Sync'; }
    });
    root.append(el('div', { class: 'card' },
      el('div', { class: 'row' },
        el('div', { class: 'grow' },
          el('h2', { style: 'margin-bottom:2px' }, '🏃 Strava'),
          el('p', { class: 'muted', style: 'font-size:13px' },
            last ? `Last sync ${timeAgo(last)} · auto-syncs at launch` : 'Not synced yet — tap Sync.')),
        syncBtn)));
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
    el('h2', {}, 'Daily check-in'),
    el('p', { class: 'muted' }, 'Rate the day in 30 seconds — and tap an earlier day to backfill one you missed.'),
    checkinForm()));

  root.append(el('p', { class: 'muted', style: 'text-align:center;font-size:11px;margin:14px 0 4px;opacity:.75' },
    `Trainer App · web build v${WEB_VERSION} · shipped ${WEB_SHIPPED}`));
}

function todayGreeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Ready to crush today?' : h < 18 ? 'How’s the day tracking?' : 'Time for the evening review.';
}

/* ---------------- Score insights (full page) ---------------- */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtWeek = iso => { const d = new Date(iso + 'T12:00:00'); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };

/* Weekly aggregate trend as an SVG line: 2px accent line, 10% area wash,
   ring-backed end dot with a direct value label; hairline gridlines at 0/50/100
   and a muted reference line where the locked baseline sits. */
function trendChart(rows, baselineRow) {
  const W = 340, H = 150, L = 30, R = 40, T = 14, B = 22;
  const y = v => T + (100 - v) / 100 * (H - T - B);
  const x = i => L + (rows.length === 1 ? 0 : i / (rows.length - 1) * (W - L - R));
  const pts = rows.map((r, i) => [x(i), y(r.aggregate)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${y(0)} L${pts[0][0].toFixed(1)},${y(0)} Z`;
  const grid = [0, 50, 100].map(v =>
    `<line x1="${L}" y1="${y(v)}" x2="${W - R}" y2="${y(v)}" stroke="#232B1B" stroke-width="1"/>` +
    `<text x="${L - 6}" y="${y(v) + 3.5}" text-anchor="end" font-size="10" fill="#8B9483">${v}</text>`).join('');
  const base = baselineRow ? (
    `<line x1="${L}" y1="${y(baselineRow.aggregate)}" x2="${W - R}" y2="${y(baselineRow.aggregate)}" stroke="#8B9483" stroke-width="1" opacity=".55"/>` +
    `<text x="${W - R}" y="${y(baselineRow.aggregate) - 4}" text-anchor="end" font-size="10" fill="#8B9483">baseline ${baselineRow.aggregate}</text>`) : '';
  const [ex, ey] = pts[pts.length - 1];
  const wrap = document.createElement('div');
  wrap.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" style="width:100%;display:block" role="img"
       aria-label="Weekly Lifestyle Score trend, latest ${rows[rows.length - 1].aggregate}">
      ${grid}${base}
      <path d="${area}" fill="#A3E635" opacity=".1"/>
      <path d="${line}" fill="none" stroke="#A3E635" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${ex}" cy="${ey}" r="4.5" fill="#A3E635" stroke="#12160E" stroke-width="2"/>
      <text x="${ex + 8}" y="${ey + 4}" font-size="12" font-weight="700" fill="#F4F6F0">${rows[rows.length - 1].aggregate}</text>
      <text x="${L}" y="${H - 6}" font-size="10" fill="#8B9483">${fmtWeek(rows[0].week_start)}</text>
      <text x="${W - R}" y="${H - 6}" text-anchor="end" font-size="10" fill="#8B9483">this week</text>
    </svg>`;
  return wrap.firstElementChild;
}

function driverRow(d) {
  const bar = el('span', { style: 'display:block;height:6px;border-radius:3px;background:var(--card-2);overflow:hidden;margin-top:5px' },
    el('i', { style: `display:block;height:100%;border-radius:3px;background:var(--accent);width:${d.score ?? 0}%` }));
  return el('div', { style: 'margin:10px 0' },
    el('div', { class: 'row', style: 'justify-content:space-between;gap:8px' },
      el('span', { style: 'font-size:14px' }, d.label),
      el('span', { class: 'muted', style: 'font-size:12px;text-align:right' }, d.value)),
    bar,
    d.score != null && d.score < 70
      ? el('p', { class: 'muted', style: 'font-size:12.5px;margin-top:5px' }, '→ ' + d.tip)
      : null);
}

async function insightsScreen() {
  history.pushState({ tab: localStorage.getItem('trainer_tab') || 'today', player: true }, '');
  const root = $('#screen');
  root.replaceChildren(el('div', { class: 'hey-row' },
    el('div', {},
      el('h1', { class: 'hey' }, 'Score insights'),
      el('p', { class: 'hey-sub' }, 'Vic’s read on your numbers')),
    vicSprite(84)));

  const { aggregate, pillars, detail } = await scoreDetail();

  // score history from the cloud (weekly rows; earliest locked row = baseline)
  let history_ = [];
  try {
    if (signedIn()) history_ = await restGet('trainer_scores', 'select=week_start,aggregate,pillars,is_baseline&order=week_start');
  } catch {}
  history_ = history_.filter(r => r.aggregate != null).slice(-12);
  const baselineRow = history_.find(r => r.is_baseline) || null;

  // quick wins: biggest score movers first (pillar weight × gap to 100)
  const wins = [];
  for (const [key, d] of Object.entries(detail)) {
    for (const dr of d.drivers) {
      if (dr.score == null || dr.score >= 85) continue;
      wins.push({ pillar: WEIGHTS[key].label, impact: WEIGHTS[key].weight * (100 - dr.score), ...dr });
    }
  }
  wins.sort((a, b) => b.impact - a.impact);

  // everything this page shows, as plain lines — Vic's briefing and the Q&A
  // below both cite from this, so he talks about the same numbers you see
  const insightsCtx = ['SCORE BREAKDOWN (drivers behind each pillar this week):']
    .concat(Object.entries(WEIGHTS).map(([k, w]) => {
      const d = detail[k];
      return `${w.label} (${Math.round(w.weight * 100)}% weight): ${d.score ?? 'no data'}` +
        (d.drivers.length ? ' — ' + d.drivers.map(dr => `${dr.label}: ${dr.value} (sub-score ${dr.score ?? 'n/a'})`).join('; ') : '');
    }))
    .concat(baselineRow ? [`Baseline score ${baselineRow.aggregate} (locked ${baselineRow.week_start}); current ${aggregate}.`] : [])
    .concat(history_.length > 1 ? ['Weekly score history: ' + history_.map(r => `${r.week_start}=${r.aggregate}`).join(', ')] : [])
    .join('\n');

  // ---- Vic delivers the breakdown ----
  const brief = el('div', { class: 'bubble vic', style: 'max-width:100%;margin-bottom:14px' },
    el('span', { class: 'tdots' }, el('i'), el('i'), el('i')));
  root.append(brief);
  vicBriefing(
    'Deliver a short spoken breakdown of my Lifestyle Score this week (under 130 words): what is carrying it, ' +
    'what is dragging it, and the ONE change that moves it most this week. Ground every claim in the SCORE BREAKDOWN numbers.',
    insightsCtx)
    .then(text => { brief.textContent = text; })
    .catch(() => { brief.textContent = fallbackBriefing(aggregate, baselineRow, wins); });

  // ---- headline: where you are, vs your locked starting point ----
  const delta = baselineRow && aggregate != null ? aggregate - baselineRow.aggregate : null;
  root.append(el('div', { class: 'card' },
    el('h2', {}, 'This week'),
    el('div', { class: 'row', style: 'gap:16px;align-items:center' },
      scoreRing(aggregate),
      el('div', { class: 'grow' },
        delta != null
          ? el('p', { style: 'font-size:15px;font-weight:700' },
              `${delta >= 0 ? '+' : ''}${delta} vs your baseline (${baselineRow.aggregate})`)
          : el('p', { class: 'muted' }, 'Baseline locks after the two-week calibration.'),
        el('p', { class: 'muted', style: 'font-size:12.5px;margin-top:6px' },
          'Weighted for weight loss: Fuel 30% · Move 25% · Recover 20% · Consistency 15% · Body 10%. ' +
          'Pillars without data are left out — never counted against you.')))));

  // ---- trend ----
  root.append(el('div', { class: 'card' },
    el('h2', {}, 'Trend — weekly score'),
    history_.length >= 2
      ? trendChart(history_, baselineRow)
      : el('p', { class: 'muted' },
          'The trend appears once two weekly scores are on record — keep logging, this fills in by itself.')));

  // ---- quick wins card ----
  if (wins.length) {
    root.append(el('div', { class: 'card' },
      el('h2', {}, 'Biggest wins available'),
      ...wins.slice(0, 3).map((w, i) => el('div', { style: 'margin:10px 0' },
        el('p', { style: 'font-size:14px;font-weight:700' }, `${i + 1}. ${w.label} `,
          el('span', { class: 'muted', style: 'font-weight:400;font-size:12px' }, `· ${w.pillar} pillar`)),
        el('p', { class: 'muted', style: 'font-size:13px;margin-top:2px' }, w.tip))),
      el('p', { class: 'muted', style: 'font-size:12px;margin-top:8px' },
        'Ranked by how much each one moves the aggregate — pillar weight × the gap to 100.')));
  }

  // ---- pillar breakdowns ----
  for (const [key, { label, weight }] of Object.entries(WEIGHTS)) {
    const d = detail[key];
    root.append(el('div', { class: 'card' },
      el('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:2px' },
        el('h2', { style: 'margin-bottom:0' }, `${label} · ${Math.round(weight * 100)}%`),
        el('span', { style: 'font-weight:700;font-size:15px' }, d.score === null ? '–' : `${d.score}`)),
      d.drivers.length
        ? el('div', {}, ...d.drivers.map(driverRow))
        : el('p', { class: 'muted' }, noDataHint(key))));
  }

  // ---- ask Vic about it, right here (same engine as the Vic tab: replies
  // keep coming if you leave, and every turn lands in the synced history) ----
  const qa = el('div', { style: 'display:flex;flex-direction:column;gap:10px' });
  const qaBase = chatHistory.length;
  const renderQa = () => {
    qa.replaceChildren(...chatHistory.slice(qaBase).flatMap(m => {
      const nodes = [el('div', { class: 'bubble ' + (m.role === 'user' ? 'me' : 'vic') }, m.content)];
      if (m.role === 'assistant' && m.actions?.length) nodes.push(actionChips(m.actions));
      return nodes;
    }));
    if (vicThinking) qa.append(thinkRow());
    qa.lastElementChild?.scrollIntoView({ block: 'end' });
    return true;
  };
  onVicUpdate = () => qa.isConnected ? renderQa() : false;
  const input = el('input', { placeholder: 'Ask Vic about your score…', enterkeyhint: 'send' });
  const send = () => {
    const text = input.value.trim();
    if (!text) return;
    if (vicThinking) return toast('Vic is mid-reply — give him a second.');
    input.value = '';
    sendToVic(text, insightsCtx);
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
  root.append(el('div', { class: 'card' },
    el('h2', {}, 'Ask Vic about it'),
    qa,
    el('div', { class: 'chat-input inline' }, input, el('button', { class: 'btn', onclick: send }, 'Send'))));
  window.scrollTo(0, 0);
}

/* Vic's voice without an API key: composed from the same wins the page shows. */
function fallbackBriefing(aggregate, baselineRow, wins) {
  const bits = [];
  bits.push(aggregate === null
    ? 'Not enough data for a score yet — log a few normal days and I’ll have numbers worth talking about.'
    : `You’re at ${aggregate} this week${baselineRow
        ? ` — ${aggregate - baselineRow.aggregate >= 0 ? 'up' : 'down'} ${Math.abs(aggregate - baselineRow.aggregate)} on your baseline of ${baselineRow.aggregate}`
        : ''}.`);
  if (wins[0]) bits.push(`Biggest lever on the board: ${wins[0].label.toLowerCase()} (${wins[0].value}). ${wins[0].tip}`);
  if (wins[1]) bits.push(`After that, ${wins[1].label.toLowerCase()} — ${wins[1].value}.`);
  bits.push('No excuses, one lever at a time. (Add your API key in Me → Settings and I’ll talk you through it properly.)');
  return bits.join(' ');
}

function noDataHint(key) {
  return {
    move: 'No workouts or step data this week — a logged walk or a Strava sync starts this pillar.',
    fuel: 'No meals or check-ins this week — the daily check-in on Today takes 30 seconds.',
    recover: 'No check-ins or Garmin day logs yet — rate sleep and energy in the daily check-in.',
    consistency: 'Nothing logged in the last 7 days.',
    body: 'Log weight most mornings — four entries start the trend.',
  }[key];
}

/* One standard-drink ≈ UK units per serving type (population averages). */
const DRINK_UNITS = { beer: 1.7, wine: 2.3, spirit: 1.4, cocktail: 2.0 };
const todayIso = () => new Date().toISOString().slice(0, 10);

/* A simple per-day quality score for the check-in chart (0–100): the mean of
   whatever was logged that day. Transparent maths, explained in the guide. */
function checkinDayScore(c) {
  if (!c) return null;
  const parts = [];
  if (c.sleep != null) parts.push((c.sleep - 1) / 4 * 100);
  if (c.energy != null) parts.push((c.energy - 1) / 4 * 100);
  if (c.water != null) parts.push(Math.min(100, c.water / 8 * 100));
  if (c.coffee != null) parts.push(c.coffee <= 2 ? 100 : c.coffee <= 4 ? 70 : 40);
  if (c.drinks != null) parts.push(c.drinks === 0 ? 100 : c.drinks <= 2 ? 75 : c.drinks <= 4 ? 45 : 20);
  return parts.length ? Math.round(parts.reduce((a, b) => a + b, 0) / parts.length) : null;
}

function checkinForm() {
  const wrap = el('div', {});
  (async () => {
    const [recent, journal] = await Promise.all([logs.recent('checkins', 8), logs.recent('journal', 8)]);
    const byDay = {}; recent.forEach(r => { byDay[r.ts.slice(0, 10)] = r; });
    const jByDay = {}; journal.forEach(r => { jByDay[r.ts.slice(0, 10)] = r; });
    const days = [];
    for (let d = 6; d >= 0; d--) days.push(new Date(Date.now() - d * 86400e3).toISOString().slice(0, 10));
    let selected = todayIso();

    const strip = el('div', {});
    const formBox = el('div', {});
    const dayLabel = iso => {
      if (iso === todayIso()) return 'Today';
      const d = new Date(iso + 'T12:00:00');
      return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] + ' ' + d.getDate();
    };
    // day selector doubling as a chart: bar height = that day's check-in score
    const renderStrip = () => strip.replaceChildren(
      el('div', { style: 'display:flex;gap:6px;align-items:flex-end;margin-bottom:12px' },
        ...days.map(d => {
          const score = checkinDayScore(byDay[d]);
          const h = score == null ? 4 : Math.max(8, score * 0.44);
          return el('button', {
            class: 'daycol' + (d === selected ? ' on' : ''),
            onclick: () => { selected = d; renderStrip(); renderForm(); },
          },
            score != null ? el('span', { class: 'daycol-num' }, String(score)) : null,
            el('span', {
              class: 'daycol-bar', style: `height:${h}px;` +
                (score == null ? 'background:var(--card-2)' : ''),
            }),
            el('span', { class: 'daycol-lab' }, dayLabel(d).split(' ')[0]));
        })));

    const renderForm = () => {
      const ex = byDay[selected] || {};
      const jx = jByDay[selected];
      const tags = new Set(jx?.tags || []);
      const alcBox = el('div', {});
      const chipRow = el('div', { class: 'chips', style: 'margin:10px 0' },
        ...JOURNAL_TAGS.map(t => el('button', {
          class: 'chip' + (tags.has(t) ? ' on' : ''),
          onclick: e => {
            e.target.classList.toggle('on');
            tags.has(t) ? tags.delete(t) : tags.add(t);
            if (t === 'Alcohol') renderAlc(); // the Alcohol chip reveals the drink counters
          },
        }, t)));
      const sleep = ratingRow('Sleep quality', ex.sleep ?? 3);
      const energy = ratingRow('Energy / mood', ex.energy ?? 3);
      const water = counterRow('💧 Water (glasses)', ex.water ?? 0);
      const coffee = counterRow('☕ Coffee (cups)', ex.coffee ?? 0);

      // alcohol by type — converted to units, since a beer is not a double whisky.
      // Hidden until the Alcohol chip is on (or the day already has drinks logged).
      const det = { beer: 0, wine: 0, spirit: 0, cocktail: 0, ...(ex.drinksDetail || {}) };
      if (ex.drinks > 0) tags.add('Alcohol');
      const unitsNow = () => Object.entries(det).reduce((a, [k, n]) => a + n * DRINK_UNITS[k], 0);
      const unitsLine = el('p', { class: 'muted', style: 'font-size:13px;margin:2px 0 0 150px' }, '');
      const updUnits = () => {
        unitsLine.textContent = unitsNow() ? `≈ ${unitsNow().toFixed(1)} units (guide: ≤14/week)` : 'Nothing counted yet.';
      };
      const renderAlc = () => {
        if (!tags.has('Alcohol')) { alcBox.replaceChildren(); return; }
        const drinkRows = [
          ['🍺 Beer / cider', 'beer'], ['🍷 Wine (glass)', 'wine'],
          ['🥃 Spirits (tot)', 'spirit'], ['🍹 Cocktail', 'cocktail'],
        ].map(([label, key]) => counterRow(label, det[key], v => { det[key] = v; updUnits(); }));
        alcBox.replaceChildren(...drinkRows.map(r => r.row), unitsLine);
        updUnits();
      };
      renderAlc();

      formBox.replaceChildren(chipRow, sleep.row, energy.row, water.row, coffee.row, alcBox,
        el('button', { class: 'chip', style: 'margin-top:8px', onclick: checkinGuideSheet },
          'ℹ️ What counts? How to log each measure'),
        el('button', {
          class: 'btn', style: 'margin-top:12px;display:block', onclick: async () => {
            const units = Math.round(unitsNow() * 10) / 10;
            if (units > 0) tags.add('Alcohol');
            const vals = {
              sleep: sleep.value(), energy: energy.value(), water: water.value(), coffee: coffee.value(),
              drinks: tags.has('Alcohol') ? units : 0, drinksDetail: { ...det },
            };
            const ts = selected === todayIso() ? new Date().toISOString() : new Date(selected + 'T20:00:00').toISOString();
            const existing = byDay[selected];
            if (existing) await logs.put('checkins', { ...existing, ...vals, synced: false });
            else await logs.add('checkins', { ts, ...vals });
            const jrow = jByDay[selected];
            if (jrow) await logs.put('journal', { ...jrow, tags: [...tags], synced: false });
            else await logs.add('journal', { ts, tags: [...tags] });
            toast(selected === todayIso() ? 'Checked in. Vic sees this.' : `Backfilled ${dayLabel(selected)} ✓`);
            trySync();
            go('today');
          },
        }, selected === todayIso() ? 'Save check-in' : `Save for ${dayLabel(selected)}`));
    };
    renderStrip(); renderForm();
    wrap.append(strip, formBox);
  })();
  return wrap;
}

/* What each measure means and when a threshold is crossed (SPEC §6). */
function checkinGuideSheet() {
  const sec = (title, ...lines) => [
    el('p', { style: 'font-weight:700;margin-top:12px' }, title),
    ...lines.map(l => el('p', { class: 'muted', style: 'font-size:13.5px;margin:3px 0' }, l)),
  ];
  sheet('What counts?',
    el('p', { class: 'muted' }, 'Every measure, what it feeds, and where the thresholds sit. Honest beats perfect — the score renormalises around anything you skip.'),
    ...sec('😴 Sleep quality (1–5)',
      '1 = broken night, under 5h. 2 = short or restless. 3 = okay, a bit groggy. 4 = solid 7h+, woke fine. 5 = 8h, woke fresh without the alarm.',
      'Feeds the Recover pillar.'),
    ...sec('⚡ Energy / mood (1–5)',
      '1 = running on fumes. 3 = normal day. 5 = firing all day.',
      'Persistent 1–2s tell Vic something (sleep, food, overtraining) needs attention.'),
    ...sec('💧 Water (glasses)',
      'A glass ≈ 250 ml. Target ≈ 8/day (~2 L). Tea and sugar-free drinks count; alcohol does not.'),
    ...sec('☕ Coffee (cups)',
      'One cup ≈ one shot/mug ≈ 100 mg caffeine. Energy drinks count as 1–2. Guide: ≤4/day, none within 8h of bed — late caffeine quietly wrecks the Sleep number.'),
    ...sec('🍺 Alcohol (tap the Alcohol chip to log)',
      'Counted in UK units per serving: beer/cider (330–500 ml) ≈ 1.7 · wine (175 ml glass) ≈ 2.3 · single spirit tot ≈ 1.4 (double = 2 tots) · cocktail ≈ 2.',
      'Low-risk guideline: ≤14 units/week. The score also credits the TREND — drinking less than your own recent baseline scores well even before you’re under 14.'),
    ...sec('🏷 Journal tags',
      'Late caffeine = within 8h of bed. Late meal = large meal within 2h of bed. Screens in bed = phone/TV after lights out. The rest are recovery helps (stretching, reading, cold shower) or context (travel).',
      'Tags don’t change the score — they explain it. After a few weeks Vic correlates them with your sleep and energy.'),
    ...sec('📊 The day bars above the form',
      'Each bar is that day’s check-in average: sleep, energy, water vs 8 glasses, coffee vs ≤2 cups, alcohol vs none. Tap a bar to view or backfill that day.'));
}

function counterRow(label, start = 0, onChange = null) {
  let val = start;
  const num = el('b', { style: 'min-width:26px;text-align:center' }, String(val));
  const btn = (txt, d) => el('button', {
    class: 'chip', onclick: () => {
      val = Math.max(0, Math.min(30, val + d));
      num.textContent = String(val);
      if (onChange) onChange(val);
    },
  }, txt);
  return {
    row: el('div', { class: 'row', style: 'margin:8px 0' },
      el('span', { class: 'muted', style: 'width:150px' }, label),
      btn('−', -1), num, btn('+', 1)),
    value: () => val,
  };
}

function ratingRow(label, initial = 3) {
  let val = initial;
  const btns = [1, 2, 3, 4, 5].map(n => el('button', {
    class: 'chip' + (n === initial ? ' on' : ''),
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

/* Vic can end a reply with [log:xxx] tags — each becomes a button that opens
   the matching form right in the chat (the sheets return to the current tab). */
const CHAT_ACTIONS = {
  benchmarks: ['⏱ Log benchmarks', () => benchmarkSheet()],
  tape: ['📏 Log tape measurements', () => measurementSheet()],
  weight: ['⚖️ Log weight', () => logWeightSheet()],
  checkin: ['📝 Daily check-in', () => go('today')],
  workout: ['🏋️ Log workout', () => logWorkoutSheet()],
  meal: ['🍲 Log meal', () => logMealSheet()],
};
function extractChatActions(reply) {
  const keys = new Set();
  const text = reply.replace(/\[log:([a-z]+)\]/gi, (m, k) => {
    if (CHAT_ACTIONS[k.toLowerCase()]) { keys.add(k.toLowerCase()); return ''; }
    return m;
  }).replace(/\n{3,}/g, '\n\n').trim();
  // fallback: he asked for a measuring session but forgot the tag
  if (!keys.size) {
    if (/\bbenchmark/i.test(reply)) keys.add('benchmarks');
    if (/\btape\b|measuring session/i.test(reply)) keys.add('tape');
  }
  return { text, keys: [...keys] };
}
function actionChips(keys) {
  if (!keys.length) return null;
  return el('div', { class: 'chips', style: 'align-self:flex-start' },
    ...keys.map(k => el('button', { class: 'chip on', onclick: CHAT_ACTIONS[k][1] }, CHAT_ACTIONS[k][0])));
}

const thinkRow = () => el('div', { class: 'bubble vic think-row' },
  el('span', { class: 'tdots' }, el('i'), el('i'), el('i')),
  el('span', { class: 'muted' }, 'Vic is thinking…'));

/* The conversation engine is DOM-independent: leaving the screen (or switching
   tabs) never drops a reply. Screens register onVicUpdate to repaint; when no
   screen is showing the chat, the reply lands as a toast + persisted history.
   Every turn is saved to IndexedDB AND synced to the cloud (trainer_chat). */
async function sendToVic(text, extraContext = '') {
  if (!settings.apiKey) { apiKeySheet(); return; }
  // one reply at a time per conversation — a second send mid-reply would race
  // the same thread and interleave the history (parallel PLAN/MEAL jobs are
  // separate requests and are fine)
  if (vicThinking) { toast('Vic is mid-reply — give him a second.'); return; }
  chatHistory.push({ role: 'user', content: text });
  await logs.add('chat', { role: 'user', text });
  await requestVicReply(extraContext);
}

async function requestVicReply(extraContext = '') {
  vicThinking = true;
  onVicUpdate?.();
  try {
    const history = chatHistory.slice(-20).map(({ role, content }) => ({ role, content }));
    const reply = await askVic(history, extraContext);
    const { text: replyText, keys } = extractChatActions(reply);
    chatHistory.push({ role: 'assistant', content: replyText, actions: keys });
    await logs.add('chat', { role: 'assistant', text: replyText, actions: keys });
    trySync();
    vicThinking = false;
    if (!(onVicUpdate?.())) toast('💬 Vic replied — check the Vic tab.');
  } catch (e) {
    vicThinking = false;
    onVicUpdate?.();
    if (e.message === 'NO_KEY') { apiKeySheet(); return; }
    toast('⚠️ Vic: ' + e.message);
  }
}

/* If a reply died mid-flight (page reloaded, or Android killed the webview in
   the background), the last stored message is a lone user question. Re-ask Vic
   automatically instead of making the user start again. */
async function resumeVicIfDangling() {
  if (vicThinking || !settings.apiKey) return;
  const stored = await logs.recent('chat', 1);
  const last = stored[stored.length - 1];
  if (!last || last.role !== 'user') return;
  if (Date.now() - Date.parse(last.ts) > 3600e3) return; // an hour old — let it lie
  if (!chatHistory.length) {
    chatHistory = stored.map(m => ({ role: m.role, content: m.text, actions: m.actions }));
  }
  await requestVicReply();
}

/* ---------------- Coach (Vic) ---------------- */
async function coach(root) {
  root.append(el('div', { class: 'hey-row', style: 'margin-bottom:8px' },
    el('div', {},
      el('h1', { class: 'hey' }, 'Vic'),
      el('p', { class: 'hey-sub', style: 'margin-bottom:0' }, '● AI Personal Trainer')),
    vicSprite(84)));
  const chat = el('div', { class: 'chat' });
  root.append(chat);

  const render = async () => {
    const stored = await logs.recent('chat', 2);
    // rehydrate the in-memory conversation after a relaunch so Vic keeps context
    if (!chatHistory.length && stored.length) {
      chatHistory = stored.map(m => ({ role: m.role, content: m.text, actions: m.actions }));
    }
    chat.replaceChildren();
    if (!stored.length) {
      bubble(chat, 'vic',
        'I’m Vic. One goal on the board: sustainable weight loss, measured properly. ' +
        'Step one is the measuring session — tape and benchmarks, Me tab. Then I build your plan: ' +
        'a theme for the month, a focus for each week, a workout for the day. No prescriptions before measurement. What’s on your mind?');
    }
    for (const m of stored) bubble(chat, m.role === 'user' ? 'me' : 'vic', m.text);
    const last = stored[stored.length - 1];
    if (!vicThinking && last?.role === 'assistant' && last.actions?.length) {
      chat.append(actionChips(last.actions));
    }
    if (vicThinking) chat.append(thinkRow());
    chat.lastElementChild?.scrollIntoView({ block: 'end' });
  };
  await render();
  onVicUpdate = () => chat.isConnected ? (render(), true) : false;

  const input = el('input', { placeholder: 'Talk to Vic…', enterkeyhint: 'send' });
  if (coachPrefill) { input.value = coachPrefill; coachPrefill = null; }
  const send = () => {
    const text = input.value.trim();
    if (!text) return;
    if (vicThinking) return toast('Vic is mid-reply — give him a second.');
    input.value = '';
    sendToVic(text);
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
  root.append(el('div', { class: 'chat-input' }, input, el('button', { class: 'btn', onclick: send }, 'Send')));
}

/* Staged progress bar for long Vic jobs (plan/meal-plan generation): the fill
   creeps toward ~92% over the expected duration while the label walks through
   the stages, then finish() snaps it to 100%. */
function vicProgress(stages, expectedMs = 35000, startedAt = null) {
  const label = el('span', { class: 'muted', style: 'font-size:13px' }, stages[0]);
  const fill = el('i', { style: 'display:block;height:100%;border-radius:3px;background:var(--accent);width:3%;transition:width .8s linear' });
  const bar = el('span', { style: 'display:block;height:6px;border-radius:3px;background:var(--card-2);overflow:hidden;margin:8px 0 6px' }, fill);
  const t0 = startedAt || Date.now();
  const tick = () => {
    if (!fill.isConnected && Date.now() - t0 > 2000) return clearInterval(timer); // screen left — stop ticking
    const f = Math.min(0.92, (Date.now() - t0) / expectedMs);
    fill.style.width = Math.max(3, f * 100).toFixed(0) + '%';
    label.textContent = stages[Math.min(stages.length - 1, Math.floor(f * stages.length))];
  };
  const timer = setInterval(tick, 800);
  setTimeout(tick, 0);
  return {
    el: el('div', { class: 'grow' },
      el('div', { class: 'row', style: 'gap:8px' },
        el('span', { class: 'tdots' }, el('i'), el('i'), el('i')), label),
      bar),
    stop: () => clearInterval(timer),
    finish: () => { clearInterval(timer); fill.style.width = '100%'; },
  };
}

function bubble(chat, cls, text) {
  const b = el('div', { class: 'bubble ' + cls }, text);
  chat.append(b);
  b.scrollIntoView({ block: 'end' });
  return b;
}

/* ---------------- Train ---------------- */

const PLAN_STAGES = [
  'Reading your measurements…', 'Reading benchmarks & equipment…',
  'Choosing the month’s theme…', 'Programming weeks 1–3…',
  'Adding the week-4 deload…', 'Final checks…',
];

function startPlanJob() {
  if (!settings.apiKey) { apiKeySheet(); return; }
  if (!planJob) {
    planJobStart = Date.now();
    planJob = generatePlan()
      .then(() => { toast('📋 Plan ready — Train tab.'); trySync(); briefPlan(); })
      .catch(e => toast(e.message === 'NO_BASELINE' ? 'Measure first — Me tab.' : '⚠️ ' + e.message))
      .finally(() => {
        planJob = null;
        if (localStorage.getItem('trainer_tab') === 'train') go('train');
      });
  }
  go('train'); // repaint into the progress state
}

/* Once a block lands, Vic talks the client through it: what to expect, why it
   fits their numbers, the outcomes targeted and how we'll KNOW it worked.
   Stored inside the plan JSON, so it syncs and survives reinstalls. */
async function briefPlan() {
  try {
    const row = (await logs.all('plans')).filter(p => p.active).pop();
    if (!row || row.plan.briefing) return false;
    const compact = {
      theme: row.plan.month_theme, rationale: row.plan.rationale, start: row.plan.start_date,
      weeks: (row.plan.weeks || []).map(w => ({
        week: w.week, theme: w.theme,
        sessions: (w.sessions || []).map(s => `${s.title} (${s.type}, ${s.duration_min}min)`),
      })),
    };
    const text = await vicBriefing(
      'You just wrote this 4-week training block for me (below). Talk me through it in under 200 words, four short parts: ' +
      '1) WHAT TO EXPECT — how the weeks feel and progress, incl. the week-4 deload. ' +
      '2) WHY THIS — why this exact block fits my current measurements, benchmarks and weight trend. ' +
      '3) THE TARGET — the concrete outcomes we are going for by the end of the block. ' +
      '4) HOW WE’LL KNOW — exactly which numbers should move (weight trend band, which benchmarks at re-test, weekly score) so we can judge it honestly.',
      'NEW TRAINING BLOCK:\n' + JSON.stringify(compact));
    row.plan.briefing = text;
    await logs.put('plans', { ...row, synced: false });
    trySync();
    if (localStorage.getItem('trainer_tab') === 'train') go('train');
    return true;
  } catch { return false; }
}
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

  // Gate 2: no plan yet → generate. The job is a SINGLETON that keeps running
  // if you leave the tab — coming back shows live progress, never a restart.
  if (!plan) {
    if (planJob) {
      const prog = vicProgress(PLAN_STAGES, 40000, planJobStart);
      root.append(el('div', { class: 'card' },
        el('h2', {}, 'Vic is building your plan'),
        el('div', { class: 'row', style: 'gap:14px;align-items:center' }, vicSprite(64, 'still'), prog.el),
        el('p', { class: 'muted', style: 'font-size:12px;margin-top:8px' },
          'Keeps working if you switch tabs — you’ll get a ping when it’s ready.')));
      return;
    }
    root.append(el('div', { class: 'card' },
      el('h2', {}, 'Ready to plan'),
      el('p', {}, 'Measurements are in. Vic will write a 4-week block: a monthly theme, a focus per week (week 4 deloads), and workouts of the day built from your equipment within your session budget.'),
      el('button', { class: 'btn', style: 'margin-top:10px', onclick: startPlanJob }, 'Vic, build my plan')));
    return;
  }

  // Active plan view: month theme → weekly focus → WOD
  const p = plan.plan;
  const t = sessionForToday(p);
  if (planJob) { // a rebuild is running — show it over the (soon-replaced) plan
    const prog = vicProgress(PLAN_STAGES, 40000, planJobStart);
    root.append(el('div', { class: 'card' },
      el('h2', {}, 'Vic is rebuilding this block'),
      el('div', { class: 'row', style: 'gap:14px;align-items:center' }, vicSprite(64, 'still'), prog.el)));
  }
  root.append(el('div', { class: 'card' },
    el('h2', {}, 'This month'),
    el('p', { style: 'font-weight:700;font-size:18px' }, p.month_theme),
    p.rationale ? el('p', { class: 'muted', style: 'margin-top:6px' }, p.rationale) : null,
    el('p', { class: 'muted', style: 'margin-top:6px' }, `Started ${p.start_date}`)));

  // Vic's walkthrough: expectations, fit, targets, and how we'll know it worked
  if (p.briefing) {
    root.append(el('div', { class: 'card' },
      el('h2', {}, 'Vic’s walkthrough'),
      el('div', { class: 'row', style: 'gap:12px;align-items:flex-start' },
        vicSprite(52, 'still'),
        el('p', { class: 'grow', style: 'white-space:pre-wrap;font-size:14.5px' }, p.briefing)),
      el('button', {
        class: 'chip', style: 'margin-top:10px', onclick: () => {
          coachPrefill = 'About my current training block — ';
          go('coach');
        },
      }, '💬 Ask Vic about the block')));
  } else if (!planJob) {
    const card = el('div', { class: 'card' },
      el('h2', {}, 'Vic’s walkthrough'),
      el('button', {
        class: 'btn ghost', onclick: async e => {
          const row = el('div', { class: 'row', style: 'gap:12px;align-items:center' },
            vicSprite(52, 'still'), thinkRow());
          e.target.replaceWith(row);
          if (!(await briefPlan())) { row.replaceWith(el('p', { class: 'muted' }, '⚠️ Couldn’t reach Vic — try again.')); }
        },
      }, '🥊 Vic, talk me through this block'));
    root.append(card);
  }

  if (t.status === 'today') {
    root.append(wodCard(t.week, t.session, true));
  } else if (t.status === 'rest') {
    root.append(el('div', { class: 'card' },
      el('h2', {}, `Week ${t.week.week} — ${t.week.theme}`),
      el('p', {}, t.next ? `Rest day. Next up: ${t.next.title}.` : 'Rest day — the week is done. Recovery is training too.')));
  } else if (t.status === 'starts') {
    root.append(el('div', { class: 'card' }, el('h2', {}, 'Starts soon'),
      el('p', {}, `The block begins ${t.when}. Week 1: ${t.week.theme}`),
      el('p', { class: 'muted', style: 'margin-top:6px' },
        'Nothing to accept — the plan is live. Your first session appears on Today that morning: tap Start session and Vic walks you through it.')));
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

  root.append(el('div', { class: 'chips' },
    el('button', { class: 'chip', onclick: () => monthSheet(p) }, '📅 Full month'),
    el('button', { class: 'chip', onclick: rebuildSheet }, '🔄 Rebuild block')),
    el('p', { class: 'muted', style: 'margin-top:8px' },
      'Each training day’s workout lands on Today by itself. After 4 weeks: re-measure in Me, then rebuild.'));
}

/* The whole mesocycle at a glance — every week, every session. */
function monthSheet(p) {
  sheet(`${p.month_theme}`,
    el('p', { class: 'muted', style: 'margin-bottom:10px' }, `Starts ${p.start_date} · 4 weeks · week 4 deloads`),
    ...(p.weeks || []).flatMap(w => [
      el('p', { style: 'font-weight:700;margin-top:10px' }, `Week ${w.week} — ${w.theme}`),
      ...(w.sessions || []).map(s => el('p', { class: 'muted', style: 'margin:3px 0 3px 10px' },
        `${['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][s.dow]} · ${s.title} (${s.duration_min} min)`)),
    ]));
}

/* Rebuild = a deliberate, explained choice — never a bare OS dialog. */
function rebuildSheet() {
  const close = sheet('Rebuild this block?',
    el('p', {}, 'Vic writes a brand-new 4-week block from your latest measurements, benchmarks and weight trend. The current block is replaced; every workout you’ve logged stays.'),
    el('p', { class: 'muted', style: 'margin-top:8px' },
      'Best used after re-measuring (Me tab) — fresh numbers, fresh plan. Mid-block rebuilds are fine too if life changed.'),
    el('div', { class: 'chips', style: 'margin-top:12px' },
      el('button', { class: 'btn', onclick: () => { close(); startPlanJob(); } }, '🔄 Rebuild now'),
      el('button', { class: 'chip', onclick: () => close() }, 'Keep current plan')));
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
  history.pushState({ tab: localStorage.getItem('trainer_tab') || 'today', player: true }, '');
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
    class: 'btn ghost', style: 'width:100%;margin-top:8px', onclick: () => history.back(),
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
  } else if (mealJob) {
    const prog = vicProgress([
      'Reading your recipes & pantry…', 'Matching macros to training days…',
      'Writing the week…', 'Final checks…',
    ], 30000, mealJobStart);
    planCard.append(el('div', { class: 'row', style: 'gap:14px;align-items:center;margin-top:6px' },
      vicSprite(64, 'still'), prog.el),
      el('p', { class: 'muted', style: 'font-size:12px;margin-top:8px' },
        'Keeps working if you switch tabs — you’ll get a ping when it’s ready.'));
  } else {
    planCard.append(el('p', { class: 'muted' },
      'Vic drafts dinners from your cookbook recipes and live pantry, macro-matched to training days. You agree it before anything syncs.'),
      el('div', { class: 'chips', style: 'margin-top:8px' },
        el('button', { class: 'btn', onclick: startMealJob }, 'Vic, draft this week'),
        mealDraft ? el('button', { class: 'chip', onclick: () => mealPlanDraftSheet(mealDraft) }, '📋 Review the draft') : null));
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

function startMealJob() {
  if (!settings.apiKey) { apiKeySheet(); return; }
  if (!mealJob) {
    mealJobStart = Date.now();
    mealJob = draftMealPlan()
      .then(d => {
        mealDraft = d;
        if (localStorage.getItem('trainer_tab') === 'fuel') mealPlanDraftSheet(d);
        else toast('🍲 Meal draft ready — Fuel tab.');
      })
      .catch(e => toast(e.message === 'NO_KEY' ? 'Add your API key first.' : '⚠️ ' + e.message))
      .finally(() => {
        mealJob = null;
        if (localStorage.getItem('trainer_tab') === 'fuel') go('fuel');
      });
  }
  go('fuel'); // repaint into the progress state
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
            mealDraft = null;
            close(); toast(r.pushed ? `Agreed — sent to the cookbook (${r.items} shopping items).` : 'Agreed — saved locally (sign in to push to the cookbook).');
            go('fuel');
          } catch (e) { toast(e.message); }
        },
      }, 'Agree ✓'),
      el('button', { class: 'chip', onclick: () => { mealDraft = null; close(); toast('Draft discarded — ask Vic again anytime.'); go('fuel'); } }, 'Discard')));
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
  // One row per metric: what's logged (value, bold) vs what's outstanding (chip).
  const measDue = !meas || daysSince(meas) >= 28;
  const benchDue = !bench || daysSince(bench) >= 56;
  const statusLine = (row, due, cadence) => !row
    ? 'Never logged — due now.'
    : due ? `Last done ${daysSince(row)}d ago — due now.`
      : `Last done ${daysSince(row)}d ago · next in ${cadence - daysSince(row)}d.`;
  const metricRow = (label, val, entryKey, howKey = null) => el('div', {
    class: 'row', style: 'justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid var(--line)',
  },
    el('span', { style: 'font-size:14px' }, label,
      howKey ? el('button', { class: 'howto', onclick: () => benchHowToSheet(howKey) }, 'how?') : null),
    val != null
      ? el('span', { class: 'row', style: 'gap:8px' },
          el('span', { style: 'font-weight:700;font-variant-numeric:tabular-nums' }, val),
          el('button', { class: 'howto', style: 'margin-left:0', onclick: () => metricEntrySheet(entryKey) }, 'edit'))
      : el('button', { class: 'chip out', onclick: () => metricEntrySheet(entryKey) }, '+ enter'));

  root.append(el('div', { class: 'card' },
    el('h2', {}, 'Tape measurements — every 4 weeks'),
    el('p', { class: measDue ? 'did-you-know' : 'muted', style: 'font-size:13px;margin-bottom:4px' },
      statusLine(meas, measDue, 28) + (!meas ? ' Your first plan waits on these.' : '')),
    metricRow('Waist', meas?.waist != null ? `${meas.waist} cm` : null, 'waist'),
    metricRow('Hips', meas?.hips != null ? `${meas.hips} cm` : null, 'hips'),
    metricRow('Chest', meas?.chest != null ? `${meas.chest} cm` : null, 'chest'),
    metricRow('Upper arm', meas?.arm != null ? `${meas.arm} cm` : null, 'arm'),
    metricRow('Thigh', meas?.thigh != null ? `${meas.thigh} cm` : null, 'thigh'),
    el('button', { class: 'btn ghost', style: 'margin-top:12px', onclick: measurementSheet }, '📏 Log all five at once')));

  root.append(el('div', { class: 'card' },
    el('h2', {}, 'Benchmarks — every 8 weeks'),
    el('p', { class: benchDue ? 'did-you-know' : 'muted', style: 'font-size:13px;margin-bottom:4px' },
      statusLine(bench, benchDue, 56)),
    metricRow('Resting heart rate', bench?.restingHr != null ? `${bench.restingHr} bpm` : null, 'hr', 'hr'),
    metricRow('1.6 km run', bench?.runSec ? fmtMinSec(bench.runSec) : null, 'run', 'run'),
    metricRow('Push-ups (max)', bench?.pushups != null ? `${bench.pushups} reps` : null, 'pushups', 'pushups'),
    metricRow('Plank hold', bench?.plankSec != null ? `${bench.plankSec} s` : null, 'plank', 'plank'),
    metricRow('Goblet squat',
      bench?.squatReps != null ? `${bench.squatReps} reps${bench.squatKg ? ` @ ${bench.squatKg} kg` : ''}` : null, 'squat', 'squat'),
    el('p', { class: 'muted', style: 'font-size:12px;margin-top:8px' },
      'Tap “how?” on any test for step-by-step instructions with an illustration.'),
    el('button', { class: 'btn ghost', style: 'margin-top:8px', onclick: benchmarkSheet }, '⏱ Log all benchmarks at once')));

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
      el('button', { class: 'chip', onclick: () => startJourney() }, '🚀 Replay setup journey')),
    el('p', { class: 'muted', style: 'margin-top:10px;font-size:12px' },
      `Web build v${WEB_VERSION} (shipped ${WEB_SHIPPED}) — updates itself when you reopen the app.`)));
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
        close(); toast('Logged. Trend updates in Me.'); trySync(); goCurrent('today');
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
        close(); toast('Meal logged.'); trySync(); goCurrent('today');
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
        close(); toast('Session logged. Vic sees it.'); trySync(); goCurrent('today');
      },
    }, 'Save'));
  input.focus();
}

function numField(label, placeholder, attrs = {}) {
  const input = el('input', { type: 'number', inputmode: 'decimal', step: '0.1', placeholder, ...attrs });
  return { row: el('div', { class: 'field' }, el('label', {}, label), input), value: () => parseFloat(input.value) || null };
}

/* A measuring "session" is one row filled in over up to 14 days. Saving merges
   non-null values into the current session row instead of adding a fresh row —
   a later partial save must never mask an earlier entry (the vanished-run bug). */
async function saveSessionValues(store, patch) {
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v != null));
  if (!Object.keys(clean).length) return false;
  const rows = (await logs.all(store)).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const latest = rows[rows.length - 1];
  if (latest && (Date.now() - Date.parse(latest.ts)) / 86400e3 <= 14) {
    await logs.put(store, { ...latest, ...clean, synced: false });
  } else {
    await logs.add(store, clean);
  }
  return true;
}

/* Single-metric entry/edit — one small sheet per measurement or benchmark. */
const METRIC_ENTRY = {
  waist: { store: 'measurements', title: 'Waist', fields: [['waist', 'Waist (cm) — at the navel, relaxed', 'e.g. 94.5']] },
  hips: { store: 'measurements', title: 'Hips', fields: [['hips', 'Hips (cm) — widest point', 'e.g. 104']] },
  chest: { store: 'measurements', title: 'Chest', fields: [['chest', 'Chest (cm) — nipple line', 'e.g. 102']] },
  arm: { store: 'measurements', title: 'Upper arm', fields: [['arm', 'Upper arm (cm) — flexed, widest', 'e.g. 34']] },
  thigh: { store: 'measurements', title: 'Thigh', fields: [['thigh', 'Thigh (cm) — widest point', 'e.g. 58']] },
  hr: { store: 'benchmarks', title: 'Resting heart rate', how: 'hr',
    fields: [['restingHr', 'Resting heart rate (bpm) — morning, before coffee', 'e.g. 62', { step: '1' }]] },
  run: { store: 'benchmarks', title: '1.6 km run', how: 'run',
    fields: [['runMin', '1.6 km run — minutes', 'e.g. 9', { step: '1' }], ['runSecPart', '…and seconds', 'e.g. 30', { step: '1' }]],
    patch: v => ({ runSec: ((v.runMin || 0) * 60 + (v.runSecPart || 0)) || null }) },
  pushups: { store: 'benchmarks', title: 'Push-ups', how: 'pushups',
    fields: [['pushups', 'Push-ups — max unbroken', 'e.g. 18', { step: '1' }]] },
  plank: { store: 'benchmarks', title: 'Plank hold', how: 'plank',
    fields: [['plankSec', 'Plank hold (seconds)', 'e.g. 60', { step: '1' }]] },
  squat: { store: 'benchmarks', title: 'Goblet squat', how: 'squat',
    fields: [['squatReps', 'Goblet squat — reps', 'e.g. 15', { step: '1' }], ['squatKg', '…with dumbbell (kg)', 'e.g. 10']] },
};

async function metricEntrySheet(key) {
  const spec = METRIC_ENTRY[key];
  const current = (spec.store === 'measurements' ? await latestMeasurement() : await latestBenchmark()) || {};
  const pre = {};
  for (const [fk] of spec.fields) pre[fk] = current[fk];
  if (key === 'run' && current.runSec) {
    pre.runMin = Math.floor(current.runSec / 60);
    pre.runSecPart = current.runSec % 60;
  }
  const inputs = spec.fields.map(([fk, label, ph, attrs]) =>
    [fk, numField(label, ph, { ...(attrs || {}), ...(pre[fk] != null ? { value: pre[fk] } : {}) })]);
  const close = sheet(spec.title,
    spec.how ? el('div', { style: 'display:flex;justify-content:center;margin:2px 0 8px' },
      exerciseAnim(BENCH_GUIDES[spec.how].art, 4)) : null,
    ...inputs.map(([, f]) => f.row),
    el('button', {
      class: 'btn', onclick: async () => {
        const vals = Object.fromEntries(inputs.map(([fk, f]) => [fk, f.value()]));
        const patch = spec.patch ? spec.patch(vals) : vals;
        if (!(await saveSessionValues(spec.store, patch))) return toast('Enter a number first, champ.');
        close(); toast(`${spec.title} saved ✓`); trySync(); goCurrent('me');
      },
    }, 'Save'));
}

async function measurementSheet() {
  const cur = (await latestMeasurement()) || {};
  const pf = v => v != null ? { value: v } : {};
  const f = {
    waist: numField('Waist (cm) — at the navel, relaxed', 'e.g. 94.5', pf(cur.waist)),
    hips: numField('Hips (cm) — widest point', 'e.g. 104', pf(cur.hips)),
    chest: numField('Chest (cm) — nipple line', 'e.g. 102', pf(cur.chest)),
    arm: numField('Upper arm (cm) — flexed, widest', 'e.g. 34', pf(cur.arm)),
    thigh: numField('Thigh (cm) — widest point', 'e.g. 58', pf(cur.thigh)),
  };
  const close = sheet('Tape measurements',
    el('p', { class: 'muted', style: 'margin-bottom:12px' },
      'Same tape, same spots, same time of day (morning is best). Every 4 weeks.'),
    ...Object.values(f).map(x => x.row),
    el('button', {
      class: 'btn', onclick: async () => {
        const vals = Object.fromEntries(Object.entries(f).map(([k, x]) => [k, x.value()]));
        if (!(await saveSessionValues('measurements', vals))) return toast('At least one measurement, champ.');
        close(); toast('Measurements saved.'); trySync(); goCurrent('me');
      },
    }, 'Save measurements'));
}

async function benchmarkSheet() {
  const cur = (await latestBenchmark()) || {};
  const pf = v => v != null ? { value: v } : {};
  const hr = numField('Resting heart rate (bpm) — morning, before coffee', 'e.g. 62', { step: '1', ...pf(cur.restingHr) });
  const runM = numField('1.6 km run — minutes', 'e.g. 9', { step: '1', ...pf(cur.runSec ? Math.floor(cur.runSec / 60) : null) });
  const runS = numField('…and seconds', 'e.g. 30', { step: '1', ...pf(cur.runSec ? cur.runSec % 60 : null) });
  const push = numField('Push-ups — max unbroken', 'e.g. 18', { step: '1', ...pf(cur.pushups) });
  const plank = numField('Plank hold (seconds)', 'e.g. 60', { step: '1', ...pf(cur.plankSec) });
  const sqReps = numField('Goblet squat — reps', 'e.g. 15', { step: '1', ...pf(cur.squatReps) });
  const sqKg = numField('…with dumbbell (kg)', 'e.g. 10', pf(cur.squatKg));
  const close = sheet('Fitness & strength benchmarks',
    el('p', { class: 'muted', style: 'margin-bottom:12px' },
      'Every 8 weeks, same conditions. Warm up first; run route should be repeatable. Blanks keep their previous value.'),
    hr.row, runM.row, runS.row, push.row, plank.row, sqReps.row, sqKg.row,
    el('button', {
      class: 'btn', onclick: async () => {
        const runSec = (runM.value() || 0) * 60 + (runS.value() || 0);
        const saved = await saveSessionValues('benchmarks', {
          restingHr: hr.value(), runSec: runSec || null, pushups: push.value(),
          plankSec: plank.value(), squatReps: sqReps.value(), squatKg: sqKg.value(),
        });
        if (!saved) return toast('Enter at least one result, champ.');
        close(); toast('Benchmarks saved.'); trySync(); goCurrent('me');
      },
    }, 'Save benchmarks'));
}

/* How to perform each benchmark test — illustrated, beginner-proof (SPEC §3.4).
   The illustration reuses the pixel exercise sprites from the session player. */
const BENCH_GUIDES = {
  hr: {
    title: 'Resting heart rate', art: 'resting',
    why: 'Your recovery baseline. It falls as your engine gets fitter — one of the clearest long-term fitness signals there is.',
    steps: [
      'Measure in the morning, still lying in bed, before coffee or standing up.',
      'Easiest: wear your Vivoactive 4 overnight — Garmin Connect shows resting HR under Health Stats → Heart Rate. Use the 7-day average.',
      'No watch overnight? Sit quietly for 5 minutes, then count your pulse at your wrist for 60 seconds.',
    ],
    record: 'Enter the number in bpm (e.g. 62). Same method every re-test.',
  },
  run: {
    title: '1.6 km timed run', art: 'run',
    why: 'Your aerobic engine in one number. Re-tested on the same route, it shows cardio fitness improving even before weight moves.',
    steps: [
      'Pick a flat, repeatable 1.6 km route — or use the treadmill.',
      'Warm up: 5 minutes brisk walking plus a few leg swings.',
      'Start the timer on your watch and run the distance at the hardest pace you can hold the whole way — it should feel like an 8/10 effort.',
      'Walk 5 minutes to cool down.',
    ],
    record: 'Enter minutes and seconds. Same route or treadmill every re-test — that’s what makes it comparable.',
  },
  pushups: {
    title: 'Push-ups — max set', art: 'push-up',
    why: 'Upper-body pushing strength relative to your own body weight.',
    steps: [
      'Hands on the floor slightly wider than your shoulders, arms straight.',
      'Body in one straight line from ankles to head — squeeze your glutes so your hips don’t sag.',
      'Lower until your chest is a fist-height off the floor, then press back up until your arms are straight. That’s one rep.',
      'Keep a steady rhythm. The set ends when you can’t do another clean rep — hips sagging or half-depth reps don’t count.',
      'Full push-ups too much today? Do them on your knees — just use the same version every re-test.',
    ],
    record: 'Enter the number of clean reps in one unbroken set.',
  },
  plank: {
    title: 'Plank hold', art: 'plank',
    why: 'Core endurance — the base that protects your back in every other lift and run.',
    steps: [
      'Forearms on the floor, elbows directly under your shoulders, feet together.',
      'Lift your hips so your body forms one straight line — squeeze glutes, tuck your chin, breathe normally.',
      'Start the timer when you’re set. Stop it the moment your hips sag or lift out of line.',
    ],
    record: 'Enter the hold in seconds.',
  },
  squat: {
    title: 'Goblet squat — max reps', art: 'goblet squat',
    why: 'Leg strength and mobility in one number, using kit you have.',
    steps: [
      'Hold ONE dumbbell vertically against your chest, both hands cupping the top end — like holding a big goblet. Elbows point down.',
      'Feet shoulder-width apart, toes turned slightly out.',
      'Sit your hips down and back between your knees — chest stays up, heels stay on the floor. Go until your elbows lightly touch your thighs, or as deep as feels controlled.',
      'Drive up through your heels back to standing. That’s one rep.',
      'Weight: pick a dumbbell you reckon you could squat 10–15 times.',
      'Do as many clean reps as you can. Stop when you slow to a grind or your heels/chest give way.',
    ],
    record: 'Enter the reps AND the dumbbell weight — both together are the benchmark.',
  },
};

function benchHowToSheet(key) {
  const g = BENCH_GUIDES[key];
  sheet(g.title,
    el('div', { style: 'display:flex;justify-content:center;margin:6px 0 10px' }, exerciseAnim(g.art, 6)),
    el('p', { class: 'muted', style: 'margin-bottom:12px' }, g.why),
    el('ol', { style: 'padding-left:20px;display:flex;flex-direction:column;gap:8px;font-size:14px' },
      ...g.steps.map(s => el('li', {}, s))),
    el('p', { class: 'did-you-know', style: 'margin-top:12px' }, '✍️ ' + g.record),
    el('button', { class: 'btn', style: 'margin-top:12px', onclick: () => metricEntrySheet(key) },
      '✍️ Enter my result'));
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
        pushProfile().catch(() => {});
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
  const email = el('input', { type: 'email', placeholder: 'you@example.com', value: s.syncEmail || 'aphilem@gmail.com', autocomplete: 'username', name: 'email' });
  const pass = el('input', { type: 'password', placeholder: 'password (min 6 chars)', autocomplete: 'current-password', name: 'password' });
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
      completePendingStrava().then(ok => { if (ok) toast('Strava connected ✓'); }).catch(e => toast('Strava: ' + e.message));
      // signing in mid-journey: restore from the cloud and skip what's already done
      if (journeyActive()) {
        try {
          await pullAll(); // includes adoptCloudSetup: API key + Strava come back too
          const [meas, bench, w] = await Promise.all([latestMeasurement(), latestBenchmark(), logs.all('weights')]);
          if (settings.apiKey && w.length && meas && bench) {
            settings.save({ profileConfirmed: true });
            completeJourney();
            toast('Welcome back — setup restored from the cloud ✓');
          }
        } catch {}
      }
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
    // a real <form> lets Android's password manager offer save + autofill
    el('form', { onsubmit: e => e.preventDefault() },
      el('div', { class: 'field' }, el('label', {}, 'Email'), email),
      el('div', { class: 'field' }, el('label', {}, 'Password'), pass)),
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
        close(); toast('Day logged. Recover pillar sees it.'); trySync(); goCurrent('me');
      },
    }, 'Save'));
}

function stravaSheet() {
  const s = settings.load();
  const id = el('input', { value: s.stravaClientId || '', placeholder: 'Client ID', inputmode: 'numeric' });
  const secret = el('input', { type: 'password', value: s.stravaClientSecret || '', placeholder: 'Client secret' });
  const status = el('p', { class: 'muted', style: 'margin-top:10px' },
    stravaConnected()
      ? 'Connected ✓' + (stravaLastImport() ? ` · last sync ${timeAgo(stravaLastImport())}` : ' · not synced yet')
      : 'Not connected.');
  completePendingStrava().then(ok => { if (ok) status.textContent = 'Connected ✓'; })
    .catch(e => { status.textContent = '⚠️ ' + e.message; });
  const guide = el('div', { class: 'muted', style: 'font-size:13px;margin-bottom:12px' },
    el('p', { style: 'margin-bottom:6px' }, el('b', {}, 'One-time setup (~2 min):')),
    el('p', {}, '1. Sign in to Cloud sync first (required — Strava calls route through your secure proxy).'),
    el('p', {}, '2. On strava.com → Settings → My API Application (strava.com/settings/api).'),
    el('p', {}, '3. Fill in: any name (not containing “Strava”) · Category: Training · Website: https://aphile-m.github.io/Lifestyle-App/ · Authorization Callback Domain: aphile-m.github.io (exactly — no https://, no path).'),
    el('p', {}, '4. Upload any square icon when asked, save, then copy the Client ID and Client Secret shown.'),
    el('p', {}, '5. Paste them below (they stay on this device) → Connect → Authorize on Strava → you land back here.'));
  sheet('Strava',
    signedIn() ? null : el('p', { class: 'did-you-know' },
      '⚠️ Sign in to Cloud sync first (Me → Settings) — connecting will fail without it.'),
    guide,
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
