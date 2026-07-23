/* vic-sprite.js — Street-Fighter-style animated Vic (img/vic-idle.png).
   The sheet: 8 idle frames sliced from AI-generated art, figure-isolated,
   baseline-aligned and packed into one horizontal strip (frame 130×237).
   Animated with steps(8) at ~7fps — smooth without overdoing it.
   Falls back to the code-drawn pixel avatar until/unless the image loads. */

import { vicAvatar } from './vic-avatar.js';

const SRC = 'img/vic-idle.png';
const FRAMES = 8;
const FRAME_W = 130, FRAME_H = 237;

let loaded = null; // null = unknown, true/false once probed
const probe = new Image();
probe.onload = () => { loaded = true; };
probe.onerror = () => { loaded = false; };
probe.src = SRC;

/* Returns an element that shows animated sprite Vic at the given height,
   or the pixel avatar if the sheet is unavailable (offline first run). */
export function vicSprite(height = 160, cls = '') {
  if (loaded === false) return vicAvatar(Math.max(2, Math.round(height / 17)), cls);
  const w = Math.round(height * FRAME_W / FRAME_H);
  const d = document.createElement('div');
  d.className = 'vic-sprite ' + cls;
  d.style.width = w + 'px';
  d.style.height = height + 'px';
  d.style.setProperty('--vsw', w + 'px');
  d.setAttribute('role', 'img');
  d.setAttribute('aria-label', 'Vic, your AI personal trainer');
  if (loaded === null) {
    probe.addEventListener('error', () => {
      d.replaceWith(vicAvatar(Math.max(2, Math.round(height / 17)), cls));
    }, { once: true });
  }
  return d;
}
