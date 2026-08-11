/* Layout regressions on the tab-bar edge.

   The bug this guards: .screen cleared --tabbar-h (64px) but the tab bar is
   actually --tabbar-h PLUS the bottom safe-area inset, so on a phone with a
   gesture bar the last lines of a screen sat underneath it, unreachable.
   env() can't be set from a test, which is why the CSS reads the inset through
   --sab — overriding that simulates a device.

   Needs `npm i -D playwright`. Run: node scripts/test-layout.js */
const { chromium } = require('playwright');
const { spawn } = require('child_process');

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};

/* Stored shape is {active, plan:{...}} — the generator's JSON nests under `plan`. */
const PLAN = { active: true, plan: {
  month_theme: 'Peak Push', start_date: '2026-08-01',
  briefing: 'Four weeks, four sessions a week.\n\nFuel is your real lever. Log today’s meals?\n\n[log:meal]',
  weeks: [{ week: 1, focus: 'Base', sessions: [{ title: 'Full Body Strength A', dow: 1, minutes: 60, type: 'strength', blocks: [] }] }],
} };

(async () => {
  const srv = spawn('node', ['serve.js'], { cwd: __dirname + '/..', stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 700));
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); // S22-ish
  await page.route('https://uaqvqvrflzxulixdrmna.supabase.co/**', r => r.fulfill({ status: 200, body: '[]' }));
  await page.addInitScript(() => localStorage.setItem('trainer_settings',
    JSON.stringify({ onboardingDone: true, profileConfirmed: true, apiKey: 'x' })));
  await page.goto('http://localhost:8123/');
  await page.waitForTimeout(600);

  await page.evaluate(async plan => {
    const { logs } = await import('./js/store.js');
    for (const p of await logs.all('plans')) await logs.del('plans', p.id);
    // Train refuses to show a plan before you've been measured — seed both so
    // the walkthrough card actually renders.
    await logs.add('measurements', { waist: 90, chest: 100 });
    await logs.add('benchmarks', { restingHr: 62, pushups: 15, runSec: 700 });
    await logs.add('plans', plan);
  }, PLAN);
  await page.evaluate(() => document.querySelector('[data-tab="train"]').click());
  await page.waitForTimeout(700);

  /* The invariant, across devices with and without a gesture bar. */
  for (const inset of [0, 24, 48]) {
    const r = await page.evaluate(async sab => {
      document.documentElement.style.setProperty('--sab', sab + 'px');
      const screen = document.querySelector('#screen');
      // force overflow so there is genuinely something to scroll to
      const probe = document.createElement('div');
      probe.id = 'probe';
      probe.style.cssText = 'height:1400px';
      probe.textContent = 'bottom';
      screen.append(probe);
      await new Promise(r => requestAnimationFrame(r));
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise(r => setTimeout(r, 120));
      const pad = parseFloat(getComputedStyle(screen).paddingBottom);
      const bar = document.querySelector('.tabbar').getBoundingClientRect();
      const last = probe.getBoundingClientRect();
      probe.remove();
      return { pad, barH: bar.height, barTop: bar.top, lastBottom: last.bottom };
    }, inset);
    check(`inset ${inset}px: screen padding clears the whole tab bar`,
      r.pad >= r.barH, `padding ${r.pad}px vs bar ${r.barH}px`);
    check(`inset ${inset}px: content scrolls fully clear of the bar`,
      r.lastBottom <= r.barTop + 0.5, `content ends at ${r.lastBottom.toFixed(0)}, bar starts at ${r.barTop.toFixed(0)}`);
  }
  await page.evaluate(() => document.documentElement.style.removeProperty('--sab'));

  /* Vic's walkthrough must not leak the raw [log:…] tag. */
  const brief = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.card')].find(c => /walkthrough/i.test(c.textContent));
    return { text: card?.textContent || '', chips: [...(card?.querySelectorAll('.chip') || [])].map(c => c.textContent) };
  });
  check('walkthrough hides the raw log tag', !/\[log:/.test(brief.text),
    (brief.text.match(/\[log:[a-z]*\]/) || [''])[0] || 'no tag present');
  check('...and renders it as a Log meal button', brief.chips.some(c => /Log meal/i.test(c)),
    brief.chips.join(' | '));

  await browser.close();
  srv.kill();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
