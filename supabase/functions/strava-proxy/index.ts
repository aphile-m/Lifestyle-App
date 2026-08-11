// strava-proxy — CORS-safe relay for the Trainer App's Strava integration.
// Browsers can't call strava.com directly (no CORS headers), so the app sends
// token exchanges and API reads here. Credentials pass through per-request and
// are never stored server-side.
//
// The app moved to Microsoft 365 in 2026-08, so there is no Supabase session to
// check any more. Instead of dropping auth (which would leave an open relay to
// strava.com) or inventing a shared secret, the caller's MICROSOFT token is
// validated against Graph /me and the returned object id is checked against an
// allowlist. That is a real identity check with no new credentials to leak.
// Deploy with verify_jwt = false so Supabase stops demanding its own JWT.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Object id of the only account allowed to use this proxy. Not a secret — it
// identifies, it does not authenticate; the Graph call is what authenticates.
const ALLOWED_OID = (Deno.env.get("ALLOWED_OID") ?? "bc9dfae5-da11-4fce-a47b-d25fa7757959")
  .split(",").map((s) => s.trim()).filter(Boolean);

async function callerIsAllowed(req: Request): Promise<boolean> {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return false;
  try {
    const me = await fetch("https://graph.microsoft.com/v1.0/me?$select=id", {
      headers: { authorization: auth },
    });
    if (!me.ok) return false;
    const { id } = await me.json();
    return !!id && ALLOWED_OID.includes(id);
  } catch {
    return false; // Graph unreachable -> refuse, never fail open
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ message: "POST only" }), { status: 405, headers: { ...CORS, "content-type": "application/json" } });
  }
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ message: "invalid JSON" }), { status: 400, headers: { ...CORS, "content-type": "application/json" } });
  }
  const action = body.action as string;

  if (!(await callerIsAllowed(req))) {
    return new Response(JSON.stringify({ message: "not authorized" }), {
      status: 401,
      headers: { ...CORS, "content-type": "application/json" },
    });
  }

  let upstream: Response;
  if (action === "token" || action === "refresh") {
    const params = action === "token"
      ? { client_id: body.client_id, client_secret: body.client_secret, code: body.code, grant_type: "authorization_code" }
      : { client_id: body.client_id, client_secret: body.client_secret, refresh_token: body.refresh_token, grant_type: "refresh_token" };
    upstream = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
  } else if (action === "activities") {
    const perPage = Math.min(Number(body.per_page) || 30, 100);
    upstream = await fetch(`https://www.strava.com/api/v3/athlete/activities?per_page=${perPage}`, {
      headers: { authorization: `Bearer ${body.access_token}` },
    });
  } else {
    return new Response(JSON.stringify({ message: "unknown action" }), { status: 400, headers: { ...CORS, "content-type": "application/json" } });
  }

  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { ...CORS, "content-type": "application/json" },
  });
});
