// strava-proxy — CORS-safe relay for the Trainer App's Strava integration.
// Browsers can't call strava.com directly (no CORS headers), so the app sends
// token exchanges and API reads here. Credentials pass through per-request and
// are never stored server-side. Requires a valid Supabase JWT (verify_jwt).
// Deployed to the shared project as version 1 on 2026-07-22.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

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
