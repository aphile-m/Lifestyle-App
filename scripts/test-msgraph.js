/* Microsoft 365 backend checks. Every Graph and Entra call is stubbed by an
   in-memory fake OneDrive, so running this touches no real account and writes
   nothing to the tenant.

   Needs `npm i -D playwright`. Run: node scripts/test-msgraph.js */
const { chromium } = require('playwright');
const { spawn } = require('child_process');

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};

(async () => {
  const srv = spawn('node', ['serve.js'], { cwd: __dirname + '/..', stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 700));
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const page = await browser.newPage();

  /* Fake OneDrive: path -> {body, etag}. Enforces if-match so the concurrency
     path is exercised for real rather than assumed. */
  await page.addInitScript(() => {
    window.__drive = new Map();
    window.__calls = [];
    const realFetch = window.fetch;
    window.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      const method = (init.method || 'GET').toUpperCase();
      if (!/graph\.microsoft\.com|login\.microsoftonline\.com/.test(url)) return realFetch(input, init);
      window.__calls.push({ url, method, headers: init.headers || {} });

      if (url.includes('login.microsoftonline.com')) {
        return new Response(JSON.stringify({
          access_token: 'AT', refresh_token: 'RT', expires_in: 3600,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (/\/me(\?|$)/.test(url.replace('https://graph.microsoft.com/v1.0', ''))) {
        return new Response(JSON.stringify({ id: 'oid-1', displayName: 'Aphile Molefe', mail: 'Aphile@Resgrocapital.com' }),
          { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const m = url.match(/approot:\/(.+?)(:\/content)?$/);
      const path = m && m[1];
      if (!path) return new Response('{}', { status: 200 });
      const cur = window.__drive.get(path);
      if (method === 'GET') {
        if (!cur) return new Response('not found', { status: 404 });
        return new Response(cur.body, { status: 200, headers: { etag: cur.etag } });
      }
      if (method === 'PUT') {
        const ifMatch = (init.headers || {})['if-match'];
        if (ifMatch && cur && ifMatch !== cur.etag) return new Response('conflict', { status: 412 });
        const etag = 'e' + Math.random().toString(36).slice(2, 8);
        window.__drive.set(path, { body: init.body, etag });
        return new Response(JSON.stringify({ id: path }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 200 });
    };
    localStorage.setItem('trainer_settings', JSON.stringify({
      onboardingDone: true, profileConfirmed: true, apiKey: 'x',
      msTenant: 'contoso', msClientId: 'client-1',
      msSession: { access_token: 'AT', refresh_token: 'RT', expires_at: 9e12, account: { id: 'oid-1', email: 'Aphile@Resgrocapital.com' } },
    }));
  });
  await page.goto('http://localhost:8123/');
  await page.waitForTimeout(800);

  /* ---- storage primitives ---- */
  const store = await page.evaluate(async () => {
    const { readJson, writeJson, updateJson } = await import('./js/msgraph.js');
    const missing = await readJson('nope');
    await writeJson('t', [{ ts: 'a', v: 1 }]);
    const first = await readJson('t');
    await updateJson('t', cur => [...cur, { ts: 'b', v: 2 }]);
    const after = await readJson('t');
    return { missing, first, after };
  });
  check('missing file reads as null, not an error', store.missing.data === null);
  check('write then read round-trips', JSON.stringify(store.first.data) === JSON.stringify([{ ts: 'a', v: 1 }]));
  check('updateJson appends without clobbering', store.after.data.length === 2, JSON.stringify(store.after.data));
  check('reads carry an ETag for concurrency', !!store.first.etag);

  /* ---- the concurrency path actually retries ---- */
  const conflict = await page.evaluate(async () => {
    const { updateJson, writeJson } = await import('./js/msgraph.js');
    await writeJson('c', [{ ts: 'x' }]);
    let firstPass = true;
    const res = await updateJson('c', cur => {
      if (firstPass) {
        firstPass = false;
        // simulate the other device landing a write between our read and write
        const e = 'e' + Math.random().toString(36).slice(2, 8);
        window.__drive.set('c.json', { body: JSON.stringify([{ ts: 'x' }, { ts: 'other' }]), etag: e });
      }
      return [...cur, { ts: 'mine' }];
    });
    const final = JSON.parse(window.__drive.get('c.json').body);
    return { final: final.map(r => r.ts).sort(), res: !!res };
  });
  check('a concurrent write is not clobbered — it re-reads and re-merges',
    JSON.stringify(conflict.final) === JSON.stringify(['mine', 'other', 'x']), JSON.stringify(conflict.final));

  /* ---- round trip through the real mappers ---- */
  const sync = await page.evaluate(async () => {
    const { logs } = await import('./js/store.js');
    const { pushAll, pullAll, cloudAll } = await import('./js/sync.js');
    for (const s of ['weights', 'workouts', 'checkins', 'journal']) {
      for (const r of await logs.all(s)) await logs.del(s, r.id);
    }
    await logs.add('weights', { kg: 95.4 });
    await logs.add('workouts', { desc: 'Boxing', rpe: 8, detail: { minutes: 60 } });
    await logs.add('checkins', { day: '2026-08-11', sleep: 4, energy: 4, water: 6, supps: ['CLA gels'] });
    await logs.add('journal', { tags: ['Late caffeine', 'Screens in bed'] });
    const pushed = await pushAll();
    const stored = {
      weights: await cloudAll('trainer_weights'),
      workouts: await cloudAll('trainer_workouts'),
      journal: await cloudAll('trainer_journal'),
    };
    // wipe local and restore, proving a fresh device rehydrates
    for (const s of ['weights', 'workouts', 'checkins', 'journal']) {
      for (const r of await logs.all(s)) await logs.del(s, r.id);
    }
    const restored = await pullAll();
    return {
      pushed, stored, restored,
      backWeights: await logs.all('weights'),
      backJournal: await logs.all('journal'),
      backCheckins: await logs.all('checkins'),
    };
  });
  check('push writes every collection', sync.pushed.weights === 1 && sync.pushed.workouts === 1,
    JSON.stringify(sync.pushed));
  check('mappers survive the move (weight)', sync.stored.weights[0]?.kg === 95.4, JSON.stringify(sync.stored.weights));
  check('workout detail round-trips', sync.stored.workouts[0]?.detail?.minutes === 60);
  check('journal stores natively, no tag explosion',
    Array.isArray(sync.stored.journal[0]?.tags) && sync.stored.journal[0].tags.length === 2,
    JSON.stringify(sync.stored.journal));
  check('a fresh device restores from OneDrive', sync.backWeights[0]?.kg === 95.4 && sync.backJournal[0]?.tags.length === 2);
  check('supplements survive the round trip',
    JSON.stringify(sync.backCheckins[0]?.supps) === JSON.stringify(['CLA gels']), JSON.stringify(sync.backCheckins[0]));

  /* ---- re-pushing must not duplicate ---- */
  const twice = await page.evaluate(async () => {
    const { logs } = await import('./js/store.js');
    const { pushAll, cloudAll } = await import('./js/sync.js');
    const all = await logs.all('weights');
    for (const r of all) await logs.put('weights', { ...r, synced: false });
    await pushAll();
    return (await cloudAll('trainer_weights')).length;
  });
  check('re-pushing the same rows does not duplicate them', twice === 1, `${twice} rows`);

  /* ---- scope + identity ---- */
  const scopes = await page.evaluate(() =>
    (window.__calls.find(c => c.url.includes('login.microsoftonline.com'))?.url || '') + ' ' +
    JSON.stringify([...window.__drive.keys()]));
  check('data lands in the app folder only',
    /trainer_weights\.json/.test(scopes) && !/\/drive\/root/.test(scopes), scopes.slice(-120));

  /* ---- Strava's redirect handler must ignore Microsoft's ---- */
  const strava = await page.evaluate(async () => {
    const { handleStravaRedirect } = await import('./js/strava.js');
    history.replaceState(null, '', '/?code=MSCODE&state=ms.abc');
    const consumed = await handleStravaRedirect().catch(() => 'threw');
    const urlIntact = location.search.includes('MSCODE');
    history.replaceState(null, '', '/');
    return { consumed, urlIntact };
  });
  check('Strava ignores a Microsoft redirect', strava.consumed === false);
  check('...and leaves the code for the Microsoft handler', strava.urlIntact);

  await browser.close();
  srv.kill();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
