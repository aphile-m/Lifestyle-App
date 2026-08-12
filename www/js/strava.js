/* strava.js — Strava import (SPEC §4.2) via the `strava-proxy` Supabase Edge Function
   (browser CORS to strava.com is blocked, so token exchange + API calls go through it).
   Uses YOUR Strava API app: create one at strava.com/settings/api, set its
   "Authorization Callback Domain" to aphile-m.github.io, and enter the client id +
   secret in the Strava sheet (stored on-device only). */

import { settings, logs } from './store.js';
import { signedIn, accessToken as cloudToken, pushProfile } from './sync.js';

/* The ONLY surviving piece of Supabase. Storage and auth moved to Microsoft 365,
   but browsers still can't call strava.com directly (no CORS headers) and M365
   has no equivalent of an edge function, so this relay stays. The caller is
   authenticated by its MICROSOFT token, which the function validates against
   Graph /me — see supabase/functions/strava-proxy/index.ts.
   These used to come from syncConfig(); after the migration that returns the
   signed-in Microsoft account instead, which silently made the URL `undefined`
   and posted to a relative path on GitHub Pages — answered with a 405. */
const PROXY_URL = 'https://uaqvqvrflzxulixdrmna.supabase.co';
const PROXY_KEY = 'sb_publishable_o1xfAQwaiVwuPkZOWgZfFw_2AsUlCOz';

const cfg = () => {
  const s = settings.load();
  return { clientId: s.stravaClientId || '', clientSecret: s.stravaClientSecret || '', tokens: s.stravaTokens || null };
};
export const stravaConfigured = () => !!(cfg().clientId && cfg().clientSecret);
export const stravaConnected = () => !!cfg().tokens;

async function proxy(body) {
  if (!signedIn()) throw new Error('Sign in to Cloud sync first (Me → Settings) — Strava routes through your secure proxy.');
  const res = await fetch(`${PROXY_URL}/functions/v1/strava-proxy`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: PROXY_KEY,
      authorization: `Bearer ${await cloudToken()}`, // Microsoft token, auto-refreshed
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.errors?.[0]?.code || `Strava call failed (${res.status})`);
  return data;
}

export function connectStrava() {
  const redirect = location.origin + location.pathname;
  location.href = 'https://www.strava.com/oauth/authorize' +
    `?client_id=${encodeURIComponent(cfg().clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirect)}` +
    '&response_type=code&scope=activity:read_all&approval_prompt=auto';
}

/* Call on boot: completes the OAuth redirect if we came back with ?code= */
export async function handleStravaRedirect() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  // Microsoft sign-in returns to this same URL with ?code= too. It tags its
  // redirect with a "ms." state; without this check whichever handler ran
  // first would consume the other's code and both flows would break.
  if ((params.get('state') || '').startsWith('ms.')) return false;
  if (!code || !stravaConfigured()) return false;
  history.replaceState(null, '', location.pathname); // strip ?code= from the URL
  if (!signedIn()) {
    // Park the authorization; it completes automatically right after sign-in.
    settings.save({ stravaPendingCode: code });
    throw new Error('Strava authorized ✓ — now sign in to Cloud sync and it will finish connecting automatically.');
  }
  const d = await proxy({ action: 'token', client_id: cfg().clientId, client_secret: cfg().clientSecret, code });
  saveTokens(d);
  return true;
}

/* Finish a parked authorization (user authorized before signing in). */
export async function completePendingStrava() {
  const code = settings.load().stravaPendingCode;
  if (!code || !signedIn() || !stravaConfigured()) return false;
  settings.save({ stravaPendingCode: null }); // single-use — clear before trying
  const d = await proxy({ action: 'token', client_id: cfg().clientId, client_secret: cfg().clientSecret, code });
  saveTokens(d);
  return true;
}

function saveTokens(d) {
  settings.save({ stravaTokens: { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: d.expires_at } });
  pushProfile().catch(() => {}); // keep the cloud device-setup mirror current
}

async function accessToken() {
  const { tokens, clientId, clientSecret } = cfg();
  if (!tokens) throw new Error('Strava not connected.');
  if (tokens.expires_at - 60 < Date.now() / 1000) {
    const d = await proxy({ action: 'refresh', client_id: clientId, client_secret: clientSecret, refresh_token: tokens.refresh_token });
    saveTokens(d);
    return d.access_token;
  }
  return tokens.access_token;
}

/* Import recent activities as workouts; dedupe on strava_id. Returns count imported. */
export async function importActivities() {
  const token = await accessToken();
  const acts = await proxy({ action: 'activities', access_token: token, per_page: 30 });
  const existing = new Set((await logs.all('workouts')).map(w => w.stravaId).filter(Boolean));
  let imported = 0;
  for (const a of acts) {
    if (existing.has(a.id)) continue;
    await logs.add('workouts', {
      ts: a.start_date,
      desc: `${a.name} (${a.sport_type || a.type})`,
      stravaId: a.id,
      planned: false,
      detail: {
        type: (a.sport_type || a.type || '').toLowerCase(),
        distance_m: a.distance, moving_time_s: a.moving_time,
        avg_hr: a.average_heartrate ?? null,
      },
    });
    imported += 1;
  }
  settings.save({ stravaLastImport: new Date().toISOString() });
  return imported;
}

export const stravaLastImport = () => settings.load().stravaLastImport || null;
