/* notify.js — wake-up alarm and daily reminders (SPEC §7).
   Android shell: @capacitor/local-notifications schedules repeating daily
   notifications that fire whether or not the app is running. Web/PWA can only
   fire while a tab is open, so the UI says so and the phone app is the alarm
   home. Times are local wall-clock and survive reboots (the plugin reschedules). */

import { settings } from './store.js';

const plugin = () =>
  (window.Capacitor?.isNativePlatform?.() && window.Capacitor.Plugins?.LocalNotifications) || null;

export const notifyNative = () => !!plugin();

const DEFAULTS = {
  enabled: false,
  wake: '05:30', wakeOn: true, // the alarm
  evening: '21:00', eveningOn: true, // log the day
  prep: '21:30', prepOn: true, // set up tomorrow
};

export const reminders = () => ({ ...DEFAULTS, ...(settings.load().reminders || {}) });

const hm = t => {
  const [h, m] = String(t || '00:00').split(':').map(Number);
  return { hour: Math.max(0, Math.min(23, h || 0)), minute: Math.max(0, Math.min(59, m || 0)) };
};

/* The three nudges, in Vic's voice — short enough to read on a lock screen. */
function planned(r) {
  const out = [];
  if (r.wakeOn) out.push({
    id: 1, channelId: 'vic-alarm', title: 'Up you get 🥊',
    body: 'Morning. Weigh in before breakfast, then we move.',
    schedule: { on: hm(r.wake), allowWhileIdle: true }, extra: { go: 'today' },
  });
  if (r.eveningOn) out.push({
    id: 2, channelId: 'vic-reminders', title: 'Log the day 📋',
    body: 'Check-in, meals, supplements — 60 seconds and I’ve got what I need.',
    schedule: { on: hm(r.evening), allowWhileIdle: true }, extra: { go: 'today' },
  });
  if (r.prepOn) out.push({
    id: 3, channelId: 'vic-reminders', title: 'Set up tomorrow 🎒',
    body: 'Check tomorrow’s session, lay the kit out, know what you’re eating.',
    schedule: { on: hm(r.prep), allowWhileIdle: true }, extra: { go: 'train' },
  });
  return out;
}

/* Ask once, then (re)write the schedule. Throws NO_PERMISSION if declined. */
export async function applyReminders() {
  const r = reminders();
  const p = plugin();
  if (!p) return webApply(r);

  let perm = await p.checkPermissions();
  if (perm.display !== 'granted') perm = await p.requestPermissions();
  if (perm.display !== 'granted') throw new Error('NO_PERMISSION');
  // Android channels: the alarm gets max importance so it breaks through
  try {
    await p.createChannel({ id: 'vic-alarm', name: 'Wake-up alarm', importance: 5, visibility: 1, vibration: true });
    await p.createChannel({ id: 'vic-reminders', name: 'Daily reminders', importance: 4, visibility: 1 });
  } catch { /* iOS/web have no channels */ }

  const pending = await p.getPending();
  if (pending.notifications?.length) {
    await p.cancel({ notifications: pending.notifications.map(n => ({ id: n.id })) });
  }
  if (!r.enabled) return { native: true, scheduled: 0 };
  const list = planned(r);
  if (list.length) await p.schedule({ notifications: list });
  return { native: true, scheduled: list.length };
}

/* ---------- web fallback: fires only while a tab is open ---------- */
let webTimers = [];
const msUntil = ({ hour, minute }) => {
  const now = new Date(), t = new Date();
  t.setHours(hour, minute, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return t - now;
};

function webApply(r) {
  webTimers.forEach(clearTimeout);
  webTimers = [];
  if (!r.enabled || typeof Notification === 'undefined' || Notification.permission !== 'granted') {
    return { native: false, scheduled: 0 };
  }
  const list = planned(r);
  for (const n of list) {
    webTimers.push(setTimeout(() => {
      try { new Notification(n.title, { body: n.body, icon: 'icon-192.png', tag: 'vic-' + n.id }); } catch { /* blocked */ }
      setTimeout(() => webApply(reminders()), 2000); // roll on to tomorrow
    }, msUntil(n.schedule.on)));
  }
  return { native: false, scheduled: list.length };
}

export async function requestWebPermission() {
  if (typeof Notification === 'undefined') throw new Error('This browser has no notifications.');
  if (Notification.permission === 'granted') return true;
  return (await Notification.requestPermission()) === 'granted';
}

/* Tapping a notification lands you where it's asking you to act. */
export function initNotifications(onOpen) {
  const p = plugin();
  if (!p) return;
  p.addListener('localNotificationActionPerformed', ev => {
    const go = ev?.notification?.extra?.go;
    if (go) onOpen?.(go);
  }).catch(() => {});
}

/* Human summary for the settings row. */
export function remindersSummary() {
  const r = reminders();
  if (!r.enabled) return 'Off — no alarm, no nudges.';
  const bits = [];
  if (r.wakeOn) bits.push(`wake ${r.wake}`);
  if (r.eveningOn) bits.push(`log ${r.evening}`);
  if (r.prepOn) bits.push(`prep ${r.prep}`);
  return bits.length ? bits.join(' · ') : 'On, but every reminder is switched off.';
}
