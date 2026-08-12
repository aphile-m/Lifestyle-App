/* msgraph.js — Microsoft 365 backend: Entra ID sign-in + OneDrive storage.

   Replaces Supabase auth + Postgres. Two deliberate choices:

   1. NO MSAL. The app is a no-build ES-module PWA and already hand-rolls
      GoTrue and Strava OAuth; a bundled dependency would be the odd one out,
      and the auth-code + PKCE flow against Entra's v2 endpoints is ~80 lines.
      Public client, no secret — the secret would be readable in the bundle
      anyway, which is exactly why PKCE exists.

   2. Files.ReadWrite.AppFolder, not Files.ReadWrite. The app gets its own
      folder under OneDrive and provably cannot read anything else in the
      tenant. On a work tenant that distinction matters: this app never has
      access to company documents, and an admin reviewing the consent can see
      that from the scope alone.

   Storage is one JSON file per store. The dataset is ~135 rows, so whole-file
   reads and writes are cheaper and far simpler than list-item CRUD, and ETag
   if-match gives real optimistic concurrency between web and phone.
*/

import { settings } from './store.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
/* offline_access is what gets a refresh token; without it the session dies
   after an hour and the phone would demand a re-login constantly. */
const SCOPES = 'openid profile offline_access User.Read Files.ReadWrite.AppFolder';
/* Strava's OAuth also comes back to this page with ?code=. Both handlers would
   otherwise grab whichever code arrived, so ours is tagged in `state` and each
   handler ignores redirects that aren't its own. */
const STATE_PREFIX = 'ms.';

export function msConfig() {
  const s = settings.load();
  return {
    tenant: s.msTenant || 'common',
    clientId: s.msClientId || '',
    session: s.msSession || null, // {access_token, refresh_token, expires_at, account}
  };
}
export const msConfigured = () => !!msConfig().clientId;
export const msSignedIn = () => !!msConfig().session;
export const msAccount = () => msConfig().session?.account || null;

const authority = t => `https://login.microsoftonline.com/${encodeURIComponent(t)}/oauth2/v2.0`;
const redirectUri = () => location.origin + location.pathname;

/* ---------- PKCE ---------- */
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function pkce() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = b64url(bytes);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

/* ---------- sign-in ---------- */
export async function msSignIn() {
  const { tenant, clientId } = msConfig();
  if (!clientId) throw new Error('Add the application (client) ID first.');
  /* Entra's Overview blade shows the tenant and client IDs side by side and it
     is easy to copy the same one twice. Left alone, that fails out on
     Microsoft's own page with AADSTS700016 ("application not found in
     directory") naming the same GUID twice, which reads like the registration
     is broken rather than mistyped. Catch it here instead. */
  if (clientId && tenant && clientId.toLowerCase() === tenant.toLowerCase()) {
    throw new Error('The client ID and tenant ID are the same value. On the app registration Overview, ' +
      'copy "Application (client) ID" — it is a different GUID from "Directory (tenant) ID".');
  }
  const { verifier, challenge } = await pkce();
  const state = STATE_PREFIX + b64url(crypto.getRandomValues(new Uint8Array(9)));
  // sessionStorage, not localStorage: the verifier is single-use and must not
  // outlive the tab that started the sign-in.
  sessionStorage.setItem('ms_pkce', JSON.stringify({ verifier, state }));
  const q = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    response_mode: 'query',
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  location.href = `${authority(tenant)}/authorize?${q}`;
}

/* Call on boot. Returns true when a Microsoft redirect was consumed.
   Ignores Strava's redirect (no ms. state) so the two can coexist. */
export async function handleMsRedirect() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const state = params.get('state') || '';
  const error = params.get('error_description') || params.get('error');
  if (error && state.startsWith(STATE_PREFIX)) {
    history.replaceState(null, '', location.pathname);
    throw new Error(decodeURIComponent(error).slice(0, 200));
  }
  if (!code || !state.startsWith(STATE_PREFIX)) return false;

  let stash = null;
  try { stash = JSON.parse(sessionStorage.getItem('ms_pkce') || 'null'); } catch {}
  history.replaceState(null, '', location.pathname); // codes are single-use
  sessionStorage.removeItem('ms_pkce');
  if (!stash || stash.state !== state) throw new Error('Sign-in state mismatch — start again.');

  const { tenant, clientId } = msConfig();
  const d = await tokenRequest(tenant, {
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    code_verifier: stash.verifier,
  });
  await saveSession(d);
  return true;
}

async function tokenRequest(tenant, form) {
  const res = await fetch(`${authority(tenant)}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) {
    // AADSTS9002326 is the one people hit: the redirect URI is registered as
    // "Web" instead of "SPA", so Entra refuses the cross-origin token call.
    const msg = d.error_description || d.error || `Sign-in failed (${res.status})`;
    throw new Error(/9002326/.test(msg)
      ? 'Entra rejected the token call because the redirect URI is registered as "Web". Change it to "Single-page application" in the app registration.'
      : String(msg).split('\n')[0].slice(0, 220));
  }
  return d;
}

async function saveSession(d) {
  const session = {
    access_token: d.access_token,
    refresh_token: d.refresh_token || msConfig().session?.refresh_token || null,
    expires_at: Math.floor(Date.now() / 1000) + (d.expires_in || 3600),
    account: msConfig().session?.account || null,
  };
  settings.save({ msSession: session });
  if (!session.account) {
    try {
      const me = await graph('GET', '/me');
      settings.save({ msSession: { ...session, account: { id: me.id, name: me.displayName, email: me.mail || me.userPrincipalName } } });
    } catch { /* identity is cosmetic; sync works without it */ }
  }
}

export function msSignOut() {
  settings.save({ msSession: null });
}

/* Always returns a fresh access token. */
export async function msToken() {
  const { tenant, session } = msConfig();
  if (!session) throw new Error('NOT_SIGNED_IN');
  if (session.expires_at - 60 > Date.now() / 1000) return session.access_token;
  if (!session.refresh_token) throw new Error('NOT_SIGNED_IN');
  const d = await tokenRequest(tenant, {
    client_id: msConfig().clientId,
    grant_type: 'refresh_token',
    refresh_token: session.refresh_token,
    scope: SCOPES,
  }).catch(e => {
    // A dead refresh token means re-consent, not a transient failure — clear
    // it so the UI offers sign-in rather than retrying forever.
    if (/invalid_grant|AADSTS7000|AADSTS500/.test(e.message)) { msSignOut(); throw new Error('NOT_SIGNED_IN'); }
    throw e;
  });
  await saveSession(d);
  return msConfig().session.access_token;
}

/* ---------- Graph ---------- */
export async function graph(method, path, body, extraHeaders = {}) {
  const res = await fetch(GRAPH + path, {
    method,
    headers: {
      authorization: `Bearer ${await msToken()}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...extraHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await graphError(res, path));
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function graphError(res, path) {
  let detail = '';
  try { detail = (await res.json())?.error?.message || ''; } catch {}
  if (res.status === 403) return `${path}: access denied (${res.status}). The app registration may be missing Files.ReadWrite.AppFolder consent. ${detail}`;
  return `${path}: Graph call failed (${res.status}) ${detail}`.trim();
}

/* ---------- app-folder JSON files ---------- */
const filePath = name => `/me/drive/special/approot:/${name}.json`;

/* Returns {data, etag} — data is null when the file doesn't exist yet. */
export async function readJson(name) {
  const res = await fetch(`${GRAPH}${filePath(name)}:/content`, {
    headers: { authorization: `Bearer ${await msToken()}` },
  });
  if (res.status === 404) return { data: null, etag: null };
  if (!res.ok) throw new Error(await graphError(res, name));
  const etag = res.headers.get('etag');
  const text = await res.text();
  try { return { data: text ? JSON.parse(text) : null, etag }; } catch {
    throw new Error(`${name}.json is not valid JSON — refusing to overwrite it.`);
  }
}

/* Writes with optimistic concurrency. Throws CONFLICT when the file changed
   underneath us so the caller can re-read, re-merge and retry rather than
   silently clobbering the other device's writes. */
export async function writeJson(name, data, etag = null) {
  const res = await fetch(`${GRAPH}${filePath(name)}:/content`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${await msToken()}`,
      'content-type': 'application/json',
      ...(etag ? { 'if-match': etag } : {}),
    },
    body: JSON.stringify(data),
  });
  if (res.status === 412) throw new Error('CONFLICT');
  if (!res.ok) throw new Error(await graphError(res, name));
  return res.json().catch(() => null);
}

/* Read → merge → write, retrying once on a concurrent change. `merge` receives
   the current array (possibly empty) and returns the array to store. */
export async function updateJson(name, merge, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    const { data, etag } = await readJson(name);
    try {
      return await writeJson(name, merge(Array.isArray(data) ? data : (data ?? [])), etag);
    } catch (e) {
      if (e.message !== 'CONFLICT' || i === attempts - 1) throw e;
    }
  }
}
