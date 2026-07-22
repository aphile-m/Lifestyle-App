/* vic-avatar.js — 8-Bit Vic, drawn as SVG pixel art (no image assets).
   Creatively animated in CSS: idle breathing bob, periodic blink, and a wave
   from the right arm. Groups: .vic-eyes and .vic-arm are separate so they can
   animate independently; everything else is the static body. */

const PAL = {
  K: '#141414', // hair / beard
  S: '#A5693B', // skin
  D: '#8A5630', // skin shadow
  W: '#F8FAFC', // eye white
  E: '#0B0B0B', // pupil
  G: '#A3E635', // lime accent (tank band, shoes)
  T: '#1B2117', // tank
  P: '#12160F', // pants
};

/* 12×19 sprite. '.' = empty. Lowercase = right-arm group (waves). */
const ROWS = [
  '...KKKKKK...',
  '..KKKKKKKK..',
  '..KSSSSSSK..',
  '..SSSSSSSS..',
  '..SWESSWES..',
  '..SSSDDSSS..',
  '..SKKKKKKS..',
  '...KKKKKK...',
  '....SSSS....',
  '..TTTTTTtt..',
  '.STTGGGGgts.',
  '.STTTTTTtts.',
  '.DTTTTTTttd.',
  '..S.TTTT.s..',
  '....PPPP....',
  '....PPPP....',
  '...PP..PP...',
  '...PP..PP...',
  '..GG....GG..',
];

const isEye = (ch, x, y) => (ch === 'W' || ch === 'E') && y === 4;

export function vicAvatar(px = 8, cls = '') {
  const w = ROWS[0].length, h = ROWS.length;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', w * px);
  svg.setAttribute('height', h * px);
  svg.setAttribute('class', 'vic-px ' + cls);
  svg.setAttribute('aria-label', 'Vic, your AI personal trainer');
  svg.setAttribute('role', 'img');

  const body = group(svg, 'vic-body');
  const eyes = group(svg, 'vic-eyes');
  const arm = group(svg, 'vic-arm');

  ROWS.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch === '.') return;
      const isArm = ch >= 'a' && ch <= 'z';
      const color = PAL[isArm ? ch.toUpperCase() : ch];
      if (!color) return;
      const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      r.setAttribute('x', x); r.setAttribute('y', y);
      r.setAttribute('width', 1.06); r.setAttribute('height', 1.06); // overlap kills seams
      r.setAttribute('fill', color);
      (isArm ? arm : isEye(ch, x, y) ? eyes : body).appendChild(r);
    });
  });
  return svg;
}

function group(svg, cls) {
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('class', cls);
  svg.appendChild(g);
  return g;
}
