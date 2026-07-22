/* ui.js — tiny DOM helpers, no framework */

export const $ = sel => document.querySelector(sel);

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children.filter(c => c != null));
  return node;
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function scoreRing(score) {
  const r = 40, c = 2 * Math.PI * r;
  const pct = score === null ? 0 : score / 100;
  const svg = `
    <svg class="score-ring" viewBox="0 0 100 100" role="img" aria-label="Lifestyle Score ${score ?? 'no data'}">
      <circle cx="50" cy="50" r="${r}" fill="none" stroke="#273449" stroke-width="9"/>
      <circle cx="50" cy="50" r="${r}" fill="none" stroke="#84CC16" stroke-width="9"
        stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct)}"
        transform="rotate(-90 50 50)"/>
      <text x="50" y="50" text-anchor="middle" dominant-baseline="central" class="score-num">${score ?? '—'}</text>
    </svg>`;
  const wrap = document.createElement('div');
  wrap.innerHTML = svg;
  return wrap.firstElementChild;
}

export function sheet(title, ...children) {
  const root = $('#overlay-root');
  const close = () => root.replaceChildren();
  const box = el('div', { class: 'sheet' }, el('h3', {}, title), ...children);
  const overlay = el('div', { class: 'overlay', onclick: e => { if (e.target === overlay) close(); } }, box);
  root.replaceChildren(overlay);
  return close;
}

export function toast(msg) {
  const t = el('div', {
    style: 'position:fixed;left:50%;transform:translateX(-50%);bottom:88px;background:#273449;' +
      'padding:10px 16px;border-radius:12px;z-index:40;font-size:14px;',
  }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}
