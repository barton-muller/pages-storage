// Token relay for "Sign in with GitHub" (GitHub App user-to-server tokens).
//
// GitHub's token endpoint needs the app's client secret and cannot be called from a web page,
// so this small function does that one step. It keeps nothing: no database, no logs of tokens.
//
// Routes (POST, JSON):
//   /token    { code, redirect_uri, code_verifier }  ->  { access_token, expires_in, refresh_token, refresh_token_expires_in }
//   /refresh  { refresh_token }                      ->  the same fields
// Routes (GET):
//   /  ->  { name, version, configured }, for checking that the Worker runs and which version
//   /return?state=<site address>&installation_id=...  ->  302 to that site (only allowed origins), keeping the query.
//   Set the GitHub App's Setup URL to <relay>/return; sites add state=<their address> to the install link.
//
// Settings (see wrangler.toml and the README):
//   GITHUB_CLIENT_ID      public, from the GitHub App
//   GITHUB_CLIENT_SECRET  secret
//   ALLOWED_ORIGINS       comma-separated site origins that may call this relay
// Each can be a variable or a secret; see .dev.vars.example.

// Keep in step with package.json (a test checks it). GET / reports it, so you can see which version a Worker runs.
export const VERSION = '0.3.0';

const TOKEN_URL = 'https://github.com/login/oauth/access_token';

const origins = (env) => (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);

const cors = (origin) => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin',
});

const json = (body, status, origin) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(origin ? cors(origin) : {}) },
  });

async function exchange(params, env) {
  const body = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, ...params });
  const r = await fetch(TOKEN_URL, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error || !j.access_token) return { ok: false, error: j.error || `github_${r.status}` };
  return {
    ok: true,
    data: {
      access_token: j.access_token,
      expires_in: j.expires_in ?? null,
      refresh_token: j.refresh_token ?? null,
      refresh_token_expires_in: j.refresh_token_expires_in ?? null,
    },
  };
}

function sendBack(url, env) {
  let to;
  try { to = new URL(url.searchParams.get('state') || ''); } catch { /* invalid */ }
  if (!to || to.protocol !== 'https:' && to.hostname !== 'localhost' || !origins(env).includes(to.origin)) {
    return new Response('This link does not point to a site that uses this relay.', { status: 400, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
  }
  for (const [k, v] of url.searchParams) if (k !== 'state' && !to.searchParams.has(k)) to.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { Location: to.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

export default {
  async fetch(request, env) {
    const u = new URL(request.url);
    if (request.method === 'GET' && u.pathname.replace(/\/+$/, '') === '/return') return sendBack(u, env);
    if (request.method === 'GET' && u.pathname === '/') {
      return json({ name: 'pages-storage', version: VERSION, configured: !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && origins(env).length) }, 200, '');
    }
    const origin = request.headers.get('Origin') || '';
    const allowed = origins(env).includes(origin);
    if (request.method === 'OPTIONS') return allowed ? new Response(null, { status: 204, headers: cors(origin) }) : new Response(null, { status: 403 });
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, allowed ? origin : '');
    if (!allowed) return json({ error: 'origin_not_allowed' }, 403, '');
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return json({ error: 'relay_not_configured' }, 500, origin);

    const path = new URL(request.url).pathname.replace(/\/+$/, '');
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'bad_request' }, 400, origin);
    }
    const str = (v, max = 2000) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);

    if (path === '/token') {
      const code = str(body.code, 200);
      const redirect = str(body.redirect_uri, 500);
      const verifier = body.code_verifier === undefined ? undefined : str(body.code_verifier, 200);
      if (!code || !redirect || verifier === null) return json({ error: 'bad_request' }, 400, origin);
      // the redirect must be on an allowed site, so a code cannot be traded for another site's callback
      let ok = false;
      try { ok = origins(env).includes(new URL(redirect).origin); } catch { /* invalid */ }
      if (!ok) return json({ error: 'redirect_not_allowed' }, 400, origin);
      const r = await exchange({ code, redirect_uri: redirect, ...(verifier ? { code_verifier: verifier } : {}) }, env);
      return r.ok ? json(r.data, 200, origin) : json({ error: r.error }, 400, origin);
    }
    if (path === '/refresh') {
      const refresh = str(body.refresh_token, 500);
      if (!refresh) return json({ error: 'bad_request' }, 400, origin);
      const r = await exchange({ grant_type: 'refresh_token', refresh_token: refresh }, env);
      return r.ok ? json(r.data, 200, origin) : json({ error: r.error }, 400, origin);
    }
    return json({ error: 'not_found' }, 404, origin);
  },
};
