/* vic-avatar.js — 8-Bit Vic v2: 24×36 high-density SVG pixel art with shading
   (no image assets). Animated in CSS: idle breathing bob, periodic blink, and a
   wave from the right arm. Groups: .vic-eyes and .vic-arm animate independently.
   The size parameter is in LEGACY 12-col pixel units so existing call sites keep
   their rendered size: vicAvatar(9) is still ~108px wide. */

const PAL = {
  H: '#181818', h: '#2A2A2A',                 // hair + highlight
  S: '#A5693B', s: '#BA7C4B', x: '#8A5630',   // skin base / highlight / shadow
  W: '#F8FAFC', E: '#0B0B0B',                 // eyes
  T: '#1F2618', t: '#2A331F',                 // tank + highlight
  G: '#A3E635', g: '#86BD2B',                 // lime + shadow
  P: '#161B10', p: '#20271A',                 // pants + highlight
  Z: '#0E0E0E',                               // soles
  A: '#A5693B', a: '#8A5630',                 // right arm (wave group)
};

/* 24×36 sprite. '.' = empty. A/a = right-arm group (waves). W/E = eyes group. */
const ROWS = [
  '........HHHHHHHH........',
  '......HHHHHHHHHHHH......',
  '......HhhHHHHHHHHH......',
  '.....HHHHHHHHHHHHHH.....',
  '.....HSSSSSSSSSSSSH.....',
  '.....HSsssSSSSSSSSH.....',
  '.....HSSSSSSSSSSSSH.....',
  '.....SSWWESSSSWWESS.....',
  '.....SSSSSSSSSSSSSS.....',
  '.....SxSSSxxSSSSSxS.....',
  '.....SSHHHHHHHHHHSS.....',
  '.....SHHHHxxxxHHHHS.....',
  '......HHHHHHHHHHHH......',
  '.......HHHHHHHHHH.......',
  '..........SSSS..........',
  '.........SSSSSS.........',
  '......TTTTTTTTTTTT......',
  '....TTTTTTTTTTTTTTTT....',
  '..SSTTTTTTTTTTTTTTTTAA..',
  '..SSTTGGGGGGGGGGGGTTAA..',
  '..SSTTggggggggggggTTAA..',
  '..SxTTTTTTTTTTTTTTTTAa..',
  '..SxTTTTTTTTTTTTTTTTAa..',
  '..SxTTtTTTTTTTTTTtTTAa..',
  '..Sx.TTTTTTTTTTTTTT.Aa..',
  '..SS.TTTTTTTTTTTTTT.AA..',
  '..ss.TTTTTTTTTTTTTT.AA..',
  '.....PPPPPPPPPPPPPP.....',
  '.....PPPPPPPPPPPPPP.....',
  '.....PPPPPP..PPPPPP.....',
  '.....PPPPPP..PPPPPP.....',
  '.....pPPPPP..PPPPPp.....',
  '.....PPPPP....PPPPP.....',
  '.....PPPPP....PPPPP.....',
  '....GGGGGG....GGGGGG....',
  '....ZZZZZZ....ZZZZZZ....',
];

const isEye = ch => ch === 'W' || ch === 'E';
const isArm = ch => ch === 'A' || ch === 'a';

export function vicAvatar(legacyPx = 8, cls = '') {
  const w = ROWS[0].length, h = ROWS.length;
  const rendered = legacyPx * 12;               // legacy 12-col sizing
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', rendered);
  svg.setAttribute('height', Math.round(rendered * h / w));
  svg.setAttribute('class', 'vic-px ' + cls);
  svg.setAttribute('aria-label', 'Vic, your AI personal trainer');
  svg.setAttribute('role', 'img');

  const body = group(svg, 'vic-body');
  const eyes = group(svg, 'vic-eyes');
  const arm = group(svg, 'vic-arm');

  ROWS.forEach((row, y) => {
    if (row.length !== w) { console.error('vic sprite row', y, 'length', row.length); return; }
    [...row].forEach((ch, x) => {
      if (ch === '.') return;
      const color = PAL[ch];
      if (!color) return;
      const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      r.setAttribute('x', x); r.setAttribute('y', y);
      r.setAttribute('width', 1.06); r.setAttribute('height', 1.06); // overlap kills seams
      r.setAttribute('fill', color);
      (isArm(ch) ? arm : isEye(ch) ? eyes : body).appendChild(r);
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
