// The part every fake host server shares: the request log, tokens, failures, and a fetch that routes to the host's handler.
//
//   handle({ method, path, query, body, token }) -> { route, status, body?, headers? }   (the host's API, written per host)
//
// Switches a test can flip: requireToken, repoMissing, down (no network), rateLimit, breakRoute(name) (answers that route with a
// body of the wrong shape), canWrite (what the host says about the token's rights).

import { createModel } from './model.js';

export function createFakeServer({ id, origin, repo = 'me/data', apiPrefix, routes, unread = [], handle, probe }) {
  const model = createModel('main');
  const server = {
    id, origin, repo, model, routes,
    // Routes whose answer the adapter does not read, only its status: a different body there is not a mismatch.
    unread,
    requireToken: null,
    repoMissing: false,
    down: false,
    rateLimit: false,
    canWrite: true,
    broken: new Set(),
    requests: [],

    breakRoute(name) { server.broken.add(name); },
    // Runs once, right before the next request that is not a read: lets a test commit "elsewhere" in the middle of a commit.
    beforeWrite: null,

    // Direct access for arranging and asserting, never through the API under test
    seed(files, branch = 'main') { return model.commit(files, { branch, message: 'seed' }); },
    commitElsewhere(changes, branch = 'main') { return model.commit(changes, { branch, message: 'elsewhere' }); },
    files: (branch = 'main') => model.texts(branch),
    head: (branch = 'main') => model.head(branch),
    commitCount: (branch = 'main') => model.depth(branch),

    fetch: async (url, init = {}) => {
      if (server.down) throw new TypeError('Failed to fetch');
      const u = new URL(url);
      const method = init.method ?? 'GET';
      const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      const auth = headers.authorization ?? '';
      const token = auth.replace(/^(Bearer|token)\s+/i, '') || headers['private-token'] || null;
      server.requests.push(`${method} ${u.pathname}${u.search}`);
      const json = (status, body, extra = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });
      if (probe && u.origin === origin) {
        const answer = probe({ method, path: u.pathname, token, server });
        if (answer) return json(answer.status, answer.body);
      }
      if (u.origin !== origin || !u.pathname.startsWith(apiPrefix)) return json(404, { message: 'Not Found' });
      if (server.rateLimit) return json(429, { message: 'rate limited' }, { 'retry-after': '60' });
      if (server.requireToken && token !== server.requireToken) return json(401, { message: 'Unauthorized' });
      if (method !== 'GET' && server.beforeWrite) { const run = server.beforeWrite; server.beforeWrite = null; run(); }
      const rest = u.pathname.slice(apiPrefix.length);
      let body;
      try { body = init.body ? JSON.parse(init.body) : undefined; } catch { return json(400, { message: 'invalid JSON' }); }
      const res = handle({ method, path: rest, query: u.searchParams, body, token, server });
      if (res.status < 300 && server.broken.has(res.route)) return json(res.status, { unexpected: true });
      return json(res.status, res.body, res.headers);
    },
  };
  return server;
}
