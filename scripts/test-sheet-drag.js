/* Sheets must come back down the way they went up.

   Every drawer in the app is built by ui.js sheet(), so these checks cover all
   of them at once. The hard requirement is that the drag coexists with the
   sheet's own scrolling — a dismiss gesture that eats scrolling is worse than
   no dismiss gesture.

   Needs `npm i -D playwright`. Run: node scripts/test-sheet-drag.js */
const { chromium } = require('playwright');
const { spawn } = require('child_process');

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};

const openSheet = async page => {
  await page.evaluate(() => document.querySelector('[data-tab="today"]').click());
  await page.waitForTimeout(400);
  await page.evaluate(() => [...document.querySelectorAll('#screen button')]
    .find(b => b.textContent.trim() === '⚖️ Weight').click());
  await page.waitForSelector('.sheet', { state: 'visible' });
  await page.waitForTimeout(250);
};

/* Drags from the sheet's grab handle. steps matter: the handler needs several
   pointermove events to decide the gesture and then follow it. */
const drag = async (page, dy, { steps = 12, delay = 12 } = {}) => {
  const box = await page.locator('.sheet .sheet-grab').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + (dy * i) / steps);
    await page.waitForTimeout(delay);
  }
  await page.mouse.up();
  await page.waitForTimeout(350);
};

(async () => {
  const srv = spawn('node', ['serve.js'], { cwd: __dirname + '/..', stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 700));
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await page.route('https://uaqvqvrflzxulixdrmna.supabase.co/**', r => r.fulfill({ status: 200, body: '[]' }));
  await page.route('https://graph.microsoft.com/**', r => r.fulfill({ status: 200, body: '[]' }));
  await page.addInitScript(() => localStorage.setItem('trainer_settings',
    JSON.stringify({ onboardingDone: true, profileConfirmed: true, apiKey: 'x' })));
  await page.goto('http://localhost:8123/');
  await page.waitForTimeout(700);

  /* ---- the affordance exists ---- */
  await openSheet(page);
  check('sheet shows a grab handle', await page.locator('.sheet .sheet-grab').isVisible());

  /* ---- a small drag springs back ---- */
  await drag(page, 30);
  const afterSmall = await page.evaluate(() => {
    const s = document.querySelector('.sheet');
    return { open: !!s, transform: s ? getComputedStyle(s).transform : null };
  });
  check('a short drag springs back instead of closing', afterSmall.open);
  check('...and leaves no residual offset',
    afterSmall.transform === 'none' || /matrix\(1, 0, 0, 1, 0, 0\)/.test(afterSmall.transform || ''),
    afterSmall.transform);

  /* ---- the sheet tracks the finger ---- */
  const tracked = await page.evaluate(async () => {
    const s = document.querySelector('.sheet');
    const g = s.querySelector('.sheet-grab').getBoundingClientRect();
    const pt = (type, y) => s.dispatchEvent(new PointerEvent(type, {
      pointerId: 1, clientX: g.x + g.width / 2, clientY: y, bubbles: true, cancelable: true,
    }));
    const y0 = g.y + g.height / 2;
    pt('pointerdown', y0);
    pt('pointermove', y0 + 20);
    pt('pointermove', y0 + 90);
    const mid = getComputedStyle(s).transform;
    pt('pointerup', y0 + 90);
    return mid;
  });
  const trackedPx = Number((tracked.match(/matrix\(1, 0, 0, 1, 0, ([\d.]+)\)/) || [])[1] || 0);
  check('sheet follows the pointer in real time', trackedPx > 60, `translateY ${trackedPx}px at 90px drag`);
  await page.waitForTimeout(350);

  /* ---- a long drag closes ---- */
  if (!(await page.locator('.sheet').count())) await openSheet(page);
  await drag(page, 400);
  check('a long drag dismisses the sheet', (await page.locator('.sheet').count()) === 0);

  /* ---- a fast flick closes even when short ---- */
  await openSheet(page);
  await drag(page, 70, { steps: 3, delay: 1 });
  check('a fast flick dismisses even from a short distance', (await page.locator('.sheet').count()) === 0);

  /* ---- back button and backdrop still work ---- */
  await openSheet(page);
  await page.goBack();
  await page.waitForTimeout(300);
  check('back button still closes the sheet', (await page.locator('.sheet').count()) === 0);

  await openSheet(page);
  await page.mouse.click(195, 60); // backdrop, well above the sheet
  await page.waitForTimeout(300);
  check('backdrop tap still closes the sheet', (await page.locator('.sheet').count()) === 0);

  /* ---- scrolling inside a tall sheet must survive ---- */
  const scrolled = await page.evaluate(async () => {
    const { sheet } = await import('./js/ui.js');
    const { el } = await import('./js/ui.js');
    const tall = el('div', { style: 'height:2000px' }, 'tall content');
    sheet('Tall', tall);
    await new Promise(r => setTimeout(r, 250));
    const s = document.querySelector('.sheet');
    s.scrollTop = 300;
    const g = s.getBoundingClientRect();
    // a downward drag from mid-scroll must NOT become a dismiss
    const pt = (type, y) => s.dispatchEvent(new PointerEvent(type, {
      pointerId: 2, clientX: g.x + g.width / 2, clientY: y, bubbles: true, cancelable: true,
    }));
    const y0 = g.y + 200;
    pt('pointerdown', y0);
    pt('pointermove', y0 + 20);
    pt('pointermove', y0 + 120);
    const t = getComputedStyle(s).transform;
    pt('pointerup', y0 + 120);
    await new Promise(r => setTimeout(r, 250));
    return { transform: t, stillOpen: !!document.querySelector('.sheet'), scrollTop: s.scrollTop };
  });
  check('dragging down mid-scroll scrolls, it does not dismiss',
    scrolled.stillOpen && (scrolled.transform === 'none' || /matrix\(1, 0, 0, 1, 0, 0\)/.test(scrolled.transform)),
    `transform ${scrolled.transform}, open ${scrolled.stillOpen}`);

  /* ---- a drag starting on a control must not hijack it ---- */
  const onInput = await page.evaluate(async () => {
    document.querySelectorAll('.overlay').forEach(o => o.remove());
    const { sheet, el } = await import('./js/ui.js');
    const input = el('input', { value: 'x' });
    sheet('Form', el('div', { class: 'field' }, input));
    await new Promise(r => setTimeout(r, 250));
    const s = document.querySelector('.sheet');
    const r = input.getBoundingClientRect();
    const pt = (type, y) => input.dispatchEvent(new PointerEvent(type, {
      pointerId: 3, clientX: r.x + 20, clientY: y, bubbles: true, cancelable: true,
    }));
    pt('pointerdown', r.y + 10);
    pt('pointermove', r.y + 90);
    const t = getComputedStyle(s).transform;
    pt('pointerup', r.y + 90);
    return t;
  });
  check('a drag begun on a form control does not move the sheet',
    onInput === 'none' || /matrix\(1, 0, 0, 1, 0, 0\)/.test(onInput), onInput);

  await browser.close();
  srv.kill();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
