/* Smoke test for the forgot-password flow. Stubs every Supabase call so nothing
   real is emailed or changed. Needs `npm i -D playwright` (deliberately not a
   dependency — android.yml runs npm install and shouldn't pull a browser).
   Run: node scripts/test-reset.js */
const { chromium } = require('playwright');
const { spawn } = require('child_process');

const SUPA = 'https://uaqvqvrflzxulixdrmna.supabase.co';
const calls = [];
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};

(async () => {
  const srv = spawn('node', ['serve.js'], { cwd: __dirname + '/..', stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 700));
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await page.route(`${SUPA}/**`, route => {
    const req = route.request();
    calls.push({ url: req.url(), method: req.method(), body: req.postData() });
    const u = req.url();
    if (u.includes('/auth/v1/recover')) return route.fulfill({ status: 200, body: '{}' });
    if (u.includes('/auth/v1/user')) return route.fulfill({ status: 200, body: JSON.stringify({ id: 'u1' }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  page.on('console', m => { if (m.type() === 'error') console.log('   [console error]', m.text().slice(0, 160)); });

  await page.addInitScript(() => {
    localStorage.setItem('trainer_settings', JSON.stringify({ onboardingDone: true, profileConfirmed: true, apiKey: 'x' }));
  });

  /* ---- 1. landing on a recovery link ---- */
  await page.goto('http://localhost:8123/#access_token=TOK123&refresh_token=REF456&expires_in=3600&type=recovery');
  await page.waitForSelector('.sheet h3', { timeout: 8000 });
  const title = await page.textContent('.sheet h3');
  check('recovery link opens the new-password sheet', title === 'Set a new password', `got "${title}"`);
  check('tokens stripped from the URL', !(await page.evaluate(() => location.hash)),
    `hash="${await page.evaluate(() => location.hash)}"`);
  const stored = await page.evaluate(() => JSON.parse(localStorage.trainer_settings).supabaseSession);
  check('recovery session adopted', stored && stored.access_token === 'TOK123');

  /* ---- 2. validation ---- */
  await page.fill('input[name="new-password"]', 'short');
  await page.fill('.sheet .field:nth-of-type(2) input', 'short');
  await page.click('.sheet button.btn');
  check('rejects a short password', (await page.textContent('.sheet p.muted:last-of-type')).includes('8 characters'));

  await page.fill('input[name="new-password"]', 'correct-horse-1');
  await page.fill('.sheet .field:nth-of-type(2) input', 'correct-horse-2');
  await page.click('.sheet button.btn');
  check('rejects a mismatch', (await page.textContent('.sheet p.muted:last-of-type')).includes('don’t match'));

  /* ---- 3. setting the password ---- */
  await page.fill('input[name="new-password"]', 'correct-horse-1');
  await page.fill('.sheet .field:nth-of-type(2) input', 'correct-horse-1');
  await page.click('.sheet button.btn');
  await page.waitForTimeout(600);
  const put = calls.find(c => c.method === 'PUT' && c.url.includes('/auth/v1/user'));
  check('PUTs the new password to /auth/v1/user', !!put && JSON.parse(put.body).password === 'correct-horse-1');
  check('sheet closes on success', !(await page.$('.sheet h3')));

  /* ---- 4. the Forgot password button ---- */
  const page2 = await ctx.newPage();
  await page2.route(`${SUPA}/**`, route => {
    calls.push({ url: route.request().url(), method: route.request().method(), body: route.request().postData() });
    route.fulfill({ status: 200, body: '{}' });
  });
  await page2.goto('http://localhost:8123/');
  await page2.waitForTimeout(500);
  await page2.evaluate(() => document.querySelector('[data-tab="me"]').click());
  await page2.waitForTimeout(300);
  await page2.click('text=Cloud sync');
  await page2.waitForSelector('.sheet h3');
  await page2.click('text=Forgot password');
  await page2.waitForTimeout(500);
  const rec = calls.find(c => c.url.includes('/auth/v1/recover'));
  check('Forgot password hits /auth/v1/recover', !!rec);
  if (rec) {
    check('sends the email in the body', JSON.parse(rec.body).email === 'aphilem@gmail.com', rec.body);
    const redirect = decodeURIComponent(new URL(rec.url).searchParams.get('redirect_to') || '');
    check('passes redirect_to back to the app', redirect === 'http://localhost:8123/', redirect);
  }
  const msg = await page2.textContent('.sheet p.muted:last-of-type');
  check('confirms without confirming the account exists', /if .*has an account/i.test(msg), msg.slice(0, 90));

  /* ---- 5. an expired link ---- */
  const page3 = await ctx.newPage();
  await page3.route(`${SUPA}/**`, r => r.fulfill({ status: 200, body: '[]' }));
  await page3.goto('http://localhost:8123/#error=access_denied&error_description=Email+link+is+invalid+or+has+expired');
  await page3.waitForTimeout(800);
  const body = await page3.textContent('body');
  check('expired link surfaces the reason', body.includes('invalid or has expired'), '');
  check('no new-password sheet for an error link', !(await page3.$('.sheet h3')));

  await browser.close();
  srv.kill();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
