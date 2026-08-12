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
  history.pushState({ overlay: true }, ''); // back button closes the sheet, not the app
  let closed = false;
  const doClose = () => {
    if (closed) return;
    closed = true;
    window.removeEventListener('popstate', doClose);
    root.replaceChildren();
  };
  window.addEventListener('popstate', doClose);
  const close = () => { if (!closed) history.back(); };
  const box = el('div', { class: 'sheet' },
    el('div', { class: 'sheet-grab', 'aria-hidden': 'true' }),
    el('h3', {}, title), ...children);
  const overlay = el('div', { class: 'overlay', onclick: e => { if (e.target === overlay) close(); } }, box);
  root.replaceChildren(overlay);
  dragToDismiss(box, overlay, close);
  return close;
}

/* A sheet covering the app must come back down the way it went up — dragging it
   is the gesture people reach for first, and without it the sheet feels stuck.
   Backdrop tap and the back button still work; this is an addition, not a
   replacement.

   The fiddly part is coexisting with the sheet's own scrolling: a drag may only
   begin when the content is already scrolled to the top, and only once the
   finger has committed to a vertical downward move. Until then every event is
   left alone so scrolling behaves normally. */
function dragToDismiss(box, overlay, close) {
  const CLOSE_FRACTION = 1 / 3;  // past a third of its height, let it go
  const FLICK = 0.5;             // px/ms — a fast flick closes from anywhere
  const SLOP = 6;                // px before a touch counts as a drag, not a tap
  let startY = 0, startX = 0, dy = 0, dragging = false, decided = false, t0 = 0;

  const setY = y => {
    box.style.transform = y ? `translateY(${y}px)` : '';
    // fade the backdrop with the drag so the gesture feels connected to it
    overlay.style.background = `rgba(2, 6, 23, ${(0.8 * (1 - Math.min(1, y / (box.offsetHeight || 1)))).toFixed(3)})`;
  };
  const reset = () => {
    box.classList.remove('dragging');
    box.style.transform = '';
    overlay.style.background = '';
  };

  box.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // don't hijack a drag that starts on a control
    if (e.target.closest('input, select, textarea, button, a')) return;
    startY = e.clientY; startX = e.clientX;
    dy = 0; dragging = false; decided = false; t0 = e.timeStamp;
  });

  box.addEventListener('pointermove', e => {
    if (!t0) return;
    const moveY = e.clientY - startY;
    const moveX = e.clientX - startX;
    if (!decided) {
      if (Math.abs(moveY) < SLOP && Math.abs(moveX) < SLOP) return;
      decided = true;
      // Only a downward move, from the top of the scroll, is a dismiss. A
      // sideways or upward move — or any move mid-scroll — belongs to the content.
      dragging = moveY > 0 && Math.abs(moveY) > Math.abs(moveX) && box.scrollTop <= 0;
      if (dragging) {
        box.classList.add('dragging');
        box.setPointerCapture?.(e.pointerId);
      }
    }
    if (!dragging) return;
    e.preventDefault();
    dy = Math.max(0, moveY);
    setY(dy);
  }, { passive: false });

  const end = e => {
    if (!dragging) { t0 = 0; return; }
    const velocity = dy / Math.max(1, e.timeStamp - t0);
    box.releasePointerCapture?.(e.pointerId);
    dragging = false; t0 = 0;
    if (dy > box.offsetHeight * CLOSE_FRACTION || velocity > FLICK) {
      // ride the gesture out rather than snapping shut under the finger
      box.classList.remove('dragging');
      box.style.transform = `translateY(${box.offsetHeight}px)`;
      overlay.style.background = 'rgba(2, 6, 23, 0)';
      setTimeout(close, 180);
    } else {
      reset(); // sprang back — the CSS transition does the animating
    }
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
}

export function toast(msg) {
  const t = el('div', {
    style: 'position:fixed;left:50%;transform:translateX(-50%);bottom:88px;background:#1C2314;' +
      'border:1px solid #232B1B;padding:10px 16px;border-radius:14px;z-index:40;font-size:14px;' +
      'max-width:min(88vw,420px);width:max-content;text-align:center;line-height:1.35;',
  }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), Math.min(6000, 2200 + msg.length * 30));
}
