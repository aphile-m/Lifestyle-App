/* exercise-art.js — animated pixel exercise sprites (SVG, zero assets).
   Each exercise is a two-frame 16×14 loop (classic sprite-game feel): both
   frames render as groups, CSS flips their opacity on a steps() timer.
   exerciseAnim(name) keyword-matches the exercise name to a sprite and
   falls back to a generic training loop. */

const PAL = {
  B: '#D7DECB', // body silhouette
  D: '#96A088', // body shade
  G: '#A3E635', // lime equipment (dumbbells, rope, band)
  L: '#232B1B', // floor line
};

/* Every sprite: [frame1rows, frame2rows], 16 cols × 14 rows. */
const SPRITES = {
  squat: [[
    '......BBBB......',
    '......BBBB......',
    '.......BB.......',
    '.....BBBBBB.....',
    '....BBBGGBBB....',
    '....B.BGGB.B....',
    '......BBBB......',
    '......BBBB......',
    '......B..B......',
    '......B..B......',
    '......B..B......',
    '.....BB..BB.....',
    '................',
    'LLLLLLLLLLLLLLLL',
  ], [
    '................',
    '................',
    '......BBBB......',
    '......BBBB......',
    '.....BBBBBB.....',
    '....BBBGGBBB....',
    '....B.BGGB.B....',
    '......BBBB......',
    '.....BB..BB.....',
    '....BB....BB....',
    '....B......B....',
    '....BB....BB....',
    '................',
    'LLLLLLLLLLLLLLLL',
  ]],
  pushup: [[
    '................',
    '................',
    '................',
    '..BBBB..........',
    '..BBBB.BBBBBBB..',
    '...BBBBBBBBBBB..',
    '...B.........B..',
    '...B.........B..',
    '................',
    '................',
    '................',
    '................',
    '................',
    'LLLLLLLLLLLLLLLL',
  ], [
    '................',
    '................',
    '................',
    '................',
    '................',
    '..BBBB..........',
    '..BBBBBBBBBBBB..',
    '...BBBBBBBBBBB..',
    '...BB........B..',
    '................',
    '................',
    '................',
    '................',
    'LLLLLLLLLLLLLLLL',
  ]],
  plank: [[
    '................',
    '................',
    '................',
    '................',
    '..BBBB..........',
    '..BBBB.BBBBBBB..',
    '...BBBBBBBBBBB..',
    '...BB........B..',
    '................',
    '................',
    '................',
    '................',
    '................',
    'LLLLLLLLLLLLLLLL',
  ], [
    '................',
    '................',
    '................',
    '................',
    '..BBBB..........',
    '..BBBBBBBBBBBB..',
    '...BBBBBBBBBBB..',
    '...BB........B..',
    '................',
    '................',
    '................',
    '................',
    '................',
    'LLLLLLLLLLLLLLLL',
  ]],
  press: [[
    '....G......G....',
    '....GB....BG....',
    '.....B....B.....',
    '......BBBB......',
    '......BBBB......',
    '.....BBBBBB.....',
    '......BBBB......',
    '......BBBB......',
    '......B..B......',
    '......B..B......',
    '......B..B......',
    '.....BB..BB.....',
    '................',
    'LLLLLLLLLLLLLLLL',
  ], [
    '................',
    '................',
    '......BBBB......',
    '......BBBB......',
    '...GBBBBBBBBG...',
    '...G.BBBBBB.G...',
    '......BBBB......',
    '......BBBB......',
    '......B..B......',
    '......B..B......',
    '......B..B......',
    '.....BB..BB.....',
    '................',
    'LLLLLLLLLLLLLLLL',
  ]],
  curl: [[
    '......BBBB......',
    '......BBBB......',
    '.......BB.......',
    '.....BBBBBB.....',
    '....BBBBBBBB....',
    '....B.BBBB.B....',
    '....G.BBBB.G....',
    '......BBBB......',
    '......B..B......',
    '......B..B......',
    '......B..B......',
    '.....BB..BB.....',
    '................',
    'LLLLLLLLLLLLLLLL',
  ], [
    '......BBBB......',
    '......BBBB......',
    '.......BB.......',
    '.....BBBBBB.....',
    '....BBBBBBBB....',
    '....BGBBBBGB....',
    '....B.BBBB.B....',
    '......BBBB......',
    '......B..B......',
    '......B..B......',
    '......B..B......',
    '.....BB..BB.....',
    '................',
    'LLLLLLLLLLLLLLLL',
  ]],
  row: [[
    '................',
    '...BBBB.........',
    '...BBBB.........',
    '.....BBBBBBB....',
    '.....BBBBBBB....',
    '......B....B....',
    '......G....B....',
    '...........B....',
    '...........B....',
    '..........BB....',
    '................',
    '................',
    '................',
    'LLLLLLLLLLLLLLLL',
  ], [
    '................',
    '...BBBB.........',
    '...BBBB.........',
    '.....BBBBBBB....',
    '.....GBBBBBB....',
    '......B....B....',
    '...........B....',
    '...........B....',
    '...........B....',
    '..........BB....',
    '................',
    '................',
    '................',
    'LLLLLLLLLLLLLLLL',
  ]],
  lunge: [[
    '......BBBB......',
    '......BBBB......',
    '.......BB.......',
    '......BBBB......',
    '......BBBB......',
    '......BBBB......',
    '......B..B......',
    '.....BB..BB.....',
    '....BB....BB....',
    '...BB......BB...',
    '..BB........BB..',
    '................',
    '................',
    'LLLLLLLLLLLLLLLL',
  ], [
    '................',
    '......BBBB......',
    '......BBBB......',
    '.......BB.......',
    '......BBBB......',
    '......BBBB......',
    '.....BB..BB.....',
    '....BB....BB....',
    '...B.......BB...',
    '...B........B...',
    '...BB.......BB..',
    '................',
    '................',
    'LLLLLLLLLLLLLLLL',
  ]],
  rope: [[
    '..G..........G..',
    '.G....BBBB....G.',
    '.G....BBBB....G.',
    '.G.....BB.....G.',
    '.G...BBBBBB...G.',
    '..G..BBBBBB..G..',
    '...GG.BBBB.GG...',
    '.....GBBBBG.....',
    '......B..B......',
    '......B..B......',
    '.....BB..BB.....',
    '................',
    '................',
    'LLLLLLLLLLLLLLLL',
  ], [
    '................',
    '......BBBB......',
    '......BBBB......',
    '.......BB.......',
    '.....BBBBBB.....',
    '.....BBBBBB.....',
    '....G.BBBB.G....',
    '...G..B..B..G...',
    '..G...B..B...G..',
    '.G....BB.BB...G.',
    '.GGGGGGGGGGGGGG.',
    '................',
    '................',
    'LLLLLLLLLLLLLLLL',
  ]],
  run: [[
    '................',
    '.....BBBB.......',
    '.....BBBB.......',
    '......BB........',
    '....BBBBB.......',
    '...B.BBBB.B.....',
    '......BBB.......',
    '.....BB.BB......',
    '....BB...BB.....',
    '...BB.....B.....',
    '..........BB....',
    '................',
    '................',
    'LLLLLLLLLLLLLLLL',
  ], [
    '................',
    '.....BBBB.......',
    '.....BBBB.......',
    '......BB........',
    '.....BBBB.......',
    '....B.BBBB.B....',
    '......BBB.......',
    '......B.B.......',
    '.....BB.BB......',
    '....B.....B.....',
    '....BB....BB....',
    '................',
    '................',
    'LLLLLLLLLLLLLLLL',
  ]],
  generic: [[
    '......BBBB......',
    '......BBBB......',
    '.......BB.......',
    '..B..BBBBBB..B..',
    '..BB.BBBBBB.BB..',
    '...BBBBBBBBBB...',
    '......BBBB......',
    '......BBBB......',
    '......B..B......',
    '......B..B......',
    '......B..B......',
    '.....BB..BB.....',
    '................',
    'LLLLLLLLLLLLLLLL',
  ], [
    '......BBBB......',
    '......BBBB......',
    '.......BB.......',
    '.GG..BBBBBB..GG.',
    '..BBBBBBBBBBBB..',
    '.....BBBBBB.....',
    '......BBBB......',
    '......BBBB......',
    '......B..B......',
    '......B..B......',
    '......B..B......',
    '.....BB..BB.....',
    '................',
    'LLLLLLLLLLLLLLLL',
  ]],
};

const KEYWORDS = [
  // specific compounds first — order decides ties ("dumbbell bench press"
  // must hit the bench, not the overhead press)
  [/pull[- ]?apart/i, 'pullapart'],
  [/step[- ]?up/i, 'stepup'],
  [/push[- ]?up|press[- ]?up/i, 'pushup'],
  [/bench|chest press|floor press|fly|flye/i, 'bench'],
  [/lateral raise|side raise|delt raise/i, 'latraise'],
  [/lunge|split squat/i, 'lunge'],
  [/squat/i, 'squat'],
  [/plank|hold/i, 'plank'],
  [/press|overhead|shoulder/i, 'press'],
  [/curl/i, 'curl'],
  [/row|pull/i, 'row'],
  [/bridge|thrust/i, 'bridge'],
  [/deadlift|\brdl\b|hinge|good ?morning/i, 'rdl'],
  [/climber/i, 'climber'],
  [/burpee/i, 'burpee'],
  [/crunch|sit[- ]?up|dead ?bug|twist|hollow|leg raise|v[- ]?up/i, 'crunch'],
  [/superman|back ext/i, 'superman'],
  [/bird[- ]?dog/i, 'birddog'],
  [/march|high[- ]?knee/i, 'march'],
  [/jack/i, 'jacks'],
  [/arm circle|arm swing|shoulder circle|shoulder roll/i, 'armcircles'],
  [/rollout|swiss|stability ball|\bball\b/i, 'swissball'],
  [/calf/i, 'calfraise'],
  [/rope|skip|jump/i, 'rope'],
  [/run|jog|walk|treadmill|step|cardio|stride/i, 'run'],
];

/* EPX/Scale2x: the classic pixel-art upscaler — doubles resolution while
   smoothing diagonals, so every sprite gains real detail without redrawing.
   Applied twice (Scale4x): 16×14 → 64×56 internal pixels at the same size. */
function scale2x(rows) {
  const H = rows.length, W = rows[0].length;
  const g = (x, y) => (y >= 0 && y < H && x >= 0 && x < W) ? rows[y][x] : '.';
  const out = Array.from({ length: H * 2 }, () => Array(W * 2).fill('.'));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const P = g(x, y), A = g(x, y - 1), B = g(x + 1, y), C = g(x - 1, y), D = g(x, y + 1);
      let e0 = P, e1 = P, e2 = P, e3 = P;
      if (C === A && C !== D && A !== B) e0 = A;
      if (A === B && A !== C && B !== D) e1 = B;
      if (D === C && D !== B && C !== A) e2 = C;
      if (B === D && B !== A && D !== C) e3 = B;
      out[y * 2][x * 2] = e0; out[y * 2][x * 2 + 1] = e1;
      out[y * 2 + 1][x * 2] = e2; out[y * 2 + 1][x * 2 + 1] = e3;
    }
  }
  return out.map(r => r.join(''));
}
const SCALED = {}; // sprite key -> two Scale4x'd frames

/* High-quality Street-Fighter-style strips (Higgsfield-generated, 8 frames,
   www/img/ex-<key>.webp). Meta ships as ex-meta.json; when present the strip
   replaces the canvas pixel art, which stays as the offline/first-paint
   fallback. */
let EX_META = null;
fetch('img/ex-meta.json')
  .then(r => (r.ok ? r.json() : null))
  .then(m => { EX_META = m; })
  .catch(() => {});

/* Canonical movement-family key for an exercise name — shared by the art
   lookup and the workout-memory matcher, so "Goblet squats 3x10" and
   "Goblet squat" land in the same family. */
export function exerciseKey(name) {
  return (KEYWORDS.find(([re]) => re.test(name || '')) || [null, 'generic'])[1];
}

export function exerciseAnim(name, px = 3, fit = null) {
  // fit: largest dimension in CSS px — sizes any frame aspect to fill a
  // fixed slot (the player's focus ring) instead of a fixed height.
  // ALWAYS try the Higgsfield strip: when ex-meta.json hasn't arrived yet
  // (cold start race) the frame aspect comes from the loaded image itself
  // (8 frames side by side); pixel art only renders if the strip 404s.
  const key = exerciseKey(name);
  const m = EX_META?.[key];
  const wrap = document.createElement('div');
  wrap.className = 'ex-strip-wrap';
  wrap.setAttribute('aria-hidden', 'true');
  const img = document.createElement('img');
  img.src = `img/ex-${key}.webp`;
  img.alt = '';
  img.className = 'ex-strip';
  const size = (fw, fh) => {
    const ratio = fw / fh;
    const h = fit ? Math.round(fit / Math.max(1, ratio)) : Math.round(14 * px);
    wrap.style.height = h + 'px';
    wrap.style.width = Math.round(h * ratio) + 'px';
  };
  if (m) size(m.fw, m.fh);
  else {
    size(1, 1); // provisional square slot until the strip reveals its aspect
    img.addEventListener('load', () => size(img.naturalWidth / 8, img.naturalHeight), { once: true });
  }
  img.addEventListener('error', () => wrap.replaceWith(pixelAnim(key, px)), { once: true });
  wrap.append(img);
  return wrap;
}

function pixelAnim(key, px) {
  if (!SPRITES[key]) key = 'generic'; // newer strip-only keys have no pixel art
  const frames = (SCALED[key] ||= SPRITES[key].map(rows => scale2x(scale2x(rows))));
  const wrap = document.createElement('div');
  wrap.className = 'ex-px';
  wrap.style.width = 16 * px + 'px';
  wrap.style.height = 14 * px + 'px';
  wrap.setAttribute('aria-hidden', 'true');
  frames.forEach((rows, i) => {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 56;
    c.className = 'exf exf-' + (i + 1);
    const ctx = c.getContext('2d');
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const color = PAL[row[x]];
        if (!color) continue;
        ctx.fillStyle = color;
        ctx.fillRect(x, y, 1, 1);
      }
    });
    wrap.append(c);
  });
  return wrap;
}
