// The one place that talks HTTP for an adapter. It turns network failures and error statuses into the errors of errors.js
// and checks the shape of what comes back, so adapters only describe the API: which calls, which fields.

import { ApiMismatch, HostError, HostUnreachable, NotFound, RateLimited, Unauthorized } from './errors.js';

const message = (body, text) => (body && typeof body === 'object' && (body.message || body.error)) || String(text ?? '').slice(0, 120);

// Throws ApiMismatch unless every path exists in the body ("commit.id"), or the body is an array for "[]".
// A value that is present but empty ('' or 0) counts as present: an empty file has empty content.
export function need(res, ...paths) {
  const missing = [];
  for (const path of paths) {
    if (path === '[]') {
      if (!Array.isArray(res.body)) missing.push('a list');
      continue;
    }
    let v = res.body;
    for (const key of path.split('.')) v = v !== null && typeof v === 'object' ? v[key] : undefined;
    if (v === undefined || v === null) missing.push(path);
  }
  if (missing.length) {
    throw new ApiMismatch(
      `${res.label} answered ${res.call} in a way this adapter does not understand (missing ${missing.map((m) => `"${m}"`).join(', ')}). ` +
      `Either ${res.label}'s API changed, or this is not a ${res.label} server. The adapter is client/hosts/${res.host}.js.`,
      { host: res.host, call: res.call, status: res.status, missing },
    );
  }
  return res;
}

export function createHttp({ host, label, base, headers = {}, fetch: fetchImpl }) {
  const origin = new URL(base).host;

  async function send(method, path, { body, query, allow = [] } = {}) {
    const call = `${method} ${path}`;
    const url = base + path + (query ? `?${new URLSearchParams(query)}` : '');
    const extra = typeof headers === 'function' ? await headers() : headers;
    let r;
    try {
      r = await fetchImpl(url, {
        method,
        cache: 'no-store',
        headers: { Accept: 'application/json', ...extra, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new HostUnreachable(
        `Could not reach ${label} at ${origin}. Check the address and the connection, and that the server allows web pages to call its API (CORS).`,
        { host, call },
      );
    }
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    const res = { host, label, call, status: r.status, ok: r.ok, body: json, text, headers: r.headers };
    if (r.ok) {
      if (json === null && text) {
        throw new ApiMismatch(`${label} answered ${call} with something that is not JSON. Is the address a ${label} server?`, { host, call, status: r.status });
      }
      return res;
    }
    if (allow.includes(r.status)) return res;
    const why = message(json, text);
    const ctx = { host, call, status: r.status };
    if (r.status === 401) throw new Unauthorized(`${label} rejected the token (expired or wrong).`, ctx);
    if (r.status === 429 || (r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0')) throw new RateLimited(`${label} says to slow down. Try again in a minute.`, ctx);
    if (r.status === 403) throw new Unauthorized(`${label} refused (${why}). The token may lack permission for this repo.`, ctx);
    if (r.status === 404) throw new NotFound(`${label} could not find it (${call}). Check the repo address and that the token can see the repo.`, ctx);
    throw new HostError(`${label} ${r.status} for ${call}: ${why}`, ctx);
  }

  return {
    send,
    get: (path, opts) => send('GET', path, opts),
    post: (path, body, opts) => send('POST', path, { ...opts, body }),
    patch: (path, body, opts) => send('PATCH', path, { ...opts, body }),
  };
}
