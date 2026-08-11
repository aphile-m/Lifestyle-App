/* Training-load checks, driven through the real modules in a browser so
   score.js/load.js run exactly as they do in the app. Nothing is written to the
   cloud — IndexedDB is seeded in a throwaway browser profile.
   Needs `npm i -D playwright`. Run: node scripts/test-load.js */
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
  await page.route('https://uaqvqvrflzxulixdrmna.supabase.co/**', r => r.fulfill({ status: 200, body: '[]' }));
  await page.goto('http://localhost:8123/');

  const r = await page.evaluate(async () => {
    const { sessionLoad, weeklyLoad, WEEKLY_LOAD_TARGET } = await import('./js/load.js');
    const golf = { desc: 'Golf round', detail: { minutes: 240, avg_hr: 95 } };
    const boxing = { desc: 'Boxing', detail: { minutes: 60, avg_hr: 150 } };
    // no heart rate: judged on the effort stars instead (rpe = stars x 2)
    const golfStars = { desc: 'Golf round', rpe: 2, detail: { minutes: 240 } };
    const boxStars = { desc: 'Boxing', rpe: 9, detail: { minutes: 60 } };
    // neither HR nor stars: fall back to the activity name
    const golfBare = { desc: 'Golf round', detail: { minutes: 240 } };
    const boxBare = { desc: 'Boxing session', detail: { minutes: 60 } };
    return {
      golf: sessionLoad(golf), boxing: sessionLoad(boxing),
      golfStars: sessionLoad(golfStars), boxStars: sessionLoad(boxStars),
      golfBare: sessionLoad(golfBare), boxBare: sessionLoad(boxBare),
      week: weeklyLoad([golf, boxing]),
      target: WEEKLY_LOAD_TARGET,
      whoModerate: sessionLoad({ desc: 'x', rpe: 6, detail: { minutes: 150 } }).au,
    };
  });

  check('4h golf scores below 1h boxing (measured HR)', r.golf.au < r.boxing.au,
    `golf ${r.golf.au} AU vs boxing ${r.boxing.au} AU`);
  check('...and by rate, boxing is far harder per minute',
    r.boxing.au / r.boxing.minutes > 4 * (r.golf.au / r.golf.minutes),
    `${(r.boxing.au / r.boxing.minutes).toFixed(2)} vs ${(r.golf.au / r.golf.minutes).toFixed(2)} AU/min`);
  check('basis is reported as heart rate when HR is present', r.golf.basis === 'heart rate');

  check('same verdict from effort stars alone', r.golfStars.au < r.boxStars.au,
    `golf ${r.golfStars.au} vs boxing ${r.boxStars.au}`);
  check('basis is reported as the effort rating', r.golfStars.basis === 'your effort rating');

  check('same verdict from the activity name alone', r.golfBare.au < r.boxBare.au,
    `golf ${r.golfBare.au} vs boxing ${r.boxBare.au}`);
  check('basis is reported as activity type', r.golfBare.basis === 'activity type');

  check('weekly total adds up', r.week.total === r.golf.au + r.boxing.au, `${r.week.total} AU`);
  check('150 min moderate ≈ the weekly target', Math.abs(r.whoModerate - r.target) <= 5,
    `${r.whoModerate} AU vs target ${r.target}`);

  /* The Move pillar must actually change its mind: a week of golf should score
     below a week of boxing, which is the opposite of counting minutes. */
  const pillar = await page.evaluate(async () => {
    const { logs } = await import('./js/store.js');
    const { scoreDetail } = await import('./js/score.js');
    const run = async rows => {
      for (const w of await logs.all('workouts')) await logs.del('workouts', w.id);
      for (const w of rows) await logs.add('workouts', w);
      const d = await scoreDetail();
      return d.detail.move.drivers.find(x => x.label === 'Training load');
    };
    const golfWeek = await run([{ desc: 'Golf round', detail: { minutes: 240, avg_hr: 95 } }]);
    const boxWeek = await run([{ desc: 'Boxing', detail: { minutes: 60, avg_hr: 150 } }]);
    return { golfWeek, boxWeek };
  });
  check('Move pillar exposes a Training load driver', !!pillar.golfWeek);
  check('4h golf week scores below 1h boxing week',
    pillar.golfWeek.score < pillar.boxWeek.score,
    `golf "${pillar.golfWeek.value}" (${pillar.golfWeek.score}) vs boxing "${pillar.boxWeek.value}" (${pillar.boxWeek.score})`);

  check('driver score is a whole number', Number.isInteger(pillar.boxWeek.score), String(pillar.boxWeek.score));

  /* The manual log sheet is where most non-Strava sessions get their duration,
     so exercise it for real: the live readout must react to the star row. */
  await page.evaluate(() => localStorage.setItem('trainer_settings',
    JSON.stringify({ onboardingDone: true, profileConfirmed: true, apiKey: 'x' })));
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://localhost:8123/');
  await page.waitForTimeout(600);
  await page.evaluate(() => document.querySelector('[data-tab="today"]').click());
  await page.waitForTimeout(300);
  await page.click('text=🏋️ Workout');
  await page.waitForSelector('.sheet h3');
  const before = await page.textContent('.sheet .loadhint');
  await page.click('.sheet .stars button:nth-child(5)'); // 5 stars = max effort
  const after = await page.textContent('.sheet .loadhint');
  check('log sheet shows a live load readout', /≈ \d+ load/.test(before), before);
  check('readout responds to the effort stars', before !== after, `${before} -> ${after}`);
  check('no page errors in the log sheet', errors.length === 0, errors.join('; '));

  await page.fill('.sheet input', 'Golf round');
  await page.click('.sheet button.btn');
  await page.waitForTimeout(400);
  const saved = await page.evaluate(async () => {
    const { logs } = await import('./js/store.js');
    const all = await logs.all('workouts');
    return all[all.length - 1];
  });
  check('manual log stores a duration', saved?.detail?.minutes > 0, JSON.stringify(saved?.detail));

  await browser.close();
  srv.kill();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
