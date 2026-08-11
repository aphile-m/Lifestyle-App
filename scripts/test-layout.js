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
    // enough real content that each tab renders its full furniture
    for (let i = 0; i < 6; i++) {
      await logs.add('weights', { kg: 96 - i * 0.2 });
      await logs.add('foods', { desc: `Meal ${i}`, kcal: 600, protein: 40 });
      await logs.add('workouts', { desc: `Session ${i}`, rpe: 6, detail: { minutes: 45 } });
      await logs.add('checkins', { day: `2026-08-0${i + 1}`, sleep: 4, energy: 4, water: 6, drinks: 0 });
    }
    await logs.add('chat', { role: 'user', text: 'How am I doing?' });
    await logs.add('chat', { role: 'vic', text: 'Solid week. '.repeat(40) });
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

  /* Every tab, with its REAL content, on a phone with a gesture bar. Measures
     the actual last rendered element rather than a probe, so anything a screen
     pins or overlays itself (Vic's composer) is caught too. */
  for (const tab of ['today', 'coach', 'train', 'fuel', 'me']) {
    await page.evaluate(t => {
      document.documentElement.style.setProperty('--sab', '48px');
      document.querySelector(`[data-tab="${t}"]`).click();
    }, tab);
    await page.waitForTimeout(900);
    const r = await page.evaluate(async () => {
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise(r => setTimeout(r, 150));
      const screen = document.querySelector('#screen');
      /* Measure painted INK, not boxes. An element's rect includes its own
         padding, so a container with a big padding-bottom (the chat list has
         150px to clear the composer) looks like it overlaps when the visible
         text is nowhere near. Text nodes via Range give the real bottom.
         The composer is inside #screen but pinned over it, so it isn't content. */
      const rects = [];
      const walk = document.createTreeWalker(screen, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        if (!n.nodeValue.trim()) continue;
        if (n.parentElement.closest('.chat-input:not(.inline)')) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        const b = range.getBoundingClientRect();
        if (b.height > 0) rects.push({ bottom: b.bottom, text: n.nodeValue.trim() });
      }
      for (const n of screen.querySelectorAll('img, canvas, svg')) {
        if (n.closest('.chat-input:not(.inline)')) continue;
        const b = n.getBoundingClientRect();
        if (b.height > 0) rects.push({ bottom: b.bottom, text: `<${n.tagName.toLowerCase()}>` });
      }
      const lowest = rects.reduce((m, r) => (!m || r.bottom > m.bottom ? r : m), null);
      const bar = document.querySelector('.tabbar').getBoundingClientRect();
      const composer = document.querySelector('.chat-input:not(.inline)');
      const cRect = composer ? composer.getBoundingClientRect() : null;
      return {
        scrollable: document.body.scrollHeight > window.innerHeight,
        lastBottom: lowest ? lowest.bottom : 0,
        lastText: (lowest?.text || '').slice(0, 40),
        barTop: bar.top,
        composerTop: cRect ? cRect.top : null,
      };
    });
    const blocker = r.composerTop != null ? Math.min(r.barTop, r.composerTop) : r.barTop;
    check(`${tab}: content clears the bottom bars (48px inset)`,
      r.lastBottom <= blocker + 0.5,
      `${r.scrollable ? 'scrollable, ' : 'fits, '}ends at ${r.lastBottom.toFixed(0)} vs ${blocker.toFixed(0)} — “${r.lastText}”`);
  }
  await page.evaluate(() => {
    document.documentElement.style.removeProperty('--sab');
    document.querySelector('[data-tab="train"]').click();
  });
  await page.waitForTimeout(700);

  /* Sheets cover the tab bar, but still have to clear the gesture bar — a
     clipped Save button is the same bug one layer up. */
  await page.evaluate(() => document.documentElement.style.setProperty('--sab', '48px'));
  await page.evaluate(() => document.querySelector('[data-tab="today"]').click());
  await page.waitForTimeout(700);
  await page.evaluate(() => [...document.querySelectorAll('#screen button')]
    .find(b => b.textContent.trim() === '⚖️ Weight').click());
  await page.waitForSelector('.sheet');
  const sh = await page.evaluate(async () => {
    const sheet = document.querySelector('.sheet');
    sheet.scrollTop = sheet.scrollHeight;
    await new Promise(r => setTimeout(r, 150));
    const box = sheet.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(sheet).paddingBottom);
    const btns = [...sheet.querySelectorAll('button')];
    const last = btns.length ? btns[btns.length - 1].getBoundingClientRect() : null;
    return {
      pad, sheetBottom: box.bottom, viewport: window.innerHeight,
      lastBtnBottom: last ? last.bottom : null,
      scrolls: sheet.scrollHeight > sheet.clientHeight,
    };
  });
  check('sheet pads for the gesture bar', sh.pad >= 48, `${sh.pad}px`);
  check('sheet content scrolls to its end above the gesture bar',
    sh.lastBtnBottom !== null && sh.lastBtnBottom <= sh.viewport - 48 + 0.5,
    `${sh.scrolls ? 'scrolls, ' : 'fits, '}last control ends at ${sh.lastBtnBottom?.toFixed(0)}, gesture bar starts at ${sh.viewport - 48}`);
  await page.evaluate(() => { history.back(); document.documentElement.style.removeProperty('--sab'); });
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector('[data-tab="train"]').click());
  await page.waitForTimeout(700);

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
