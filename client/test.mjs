// Run: node client/test.mjs   (Node 18+; GitHub and the relay are mocked)
import { createClient, Conflict } from './ghstore.js';

const store = new Map();
const mem = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.localStorage = mem;
globalThis.sessionStorage = { ...mem, getItem: (k) => store.get('s' + k) ?? null, setItem: (k, v) => store.set('s' + k, v), removeItem: (k) => store.delete('s' + k) };
let loc = 'https://me.github.io/app/';
const L = { origin: 'https://me.github.io', pathname: '/app/', hash: '', get search() { return new URL(loc).search; }, assign: (u) => { L.went = u; } };
globalThis.location = L;
globalThis.history = { replaceState: (_, __, u) => { loc = 'https://me.github.io' + u; } };

const file = { text: 'héllo', sha: 'sha1' };
const calls = [];
let headSha = 'h1', treeBody = null, commitBody = null, patchFails = 0;
const fetchImpl = async (url, init = {}) => {
  calls.push({ url, init });
  const ok = (b, status = 200) => new Response(JSON.stringify(b), { status });
  if (url.endsWith('/token')) return ok({ access_token: 'ghu_1', expires_in: 28800, refresh_token: 'ghr_1', refresh_token_expires_in: 1e7 });
  if (url.endsWith('/refresh')) return ok({ access_token: 'ghu_2', expires_in: 28800, refresh_token: 'ghr_2', refresh_token_expires_in: 1e7 });
  if (url.endsWith('/user')) return ok({ login: 'me' });
  if (url.includes('/user/installations?')) return ok({ installations: [{ id: 5 }] });
  if (url.includes('/installations/5/repositories')) return ok({ repositories: [{ full_name: 'me/data', default_branch: 'main' }] });
  if (url.includes('/contents/') && init.method === 'PUT') {
    const b = JSON.parse(init.body);
    if (b.sha !== file.sha && file.sha) return ok({}, 409);
    file.text = new TextDecoder().decode(Uint8Array.from(atob(b.content), (c) => c.charCodeAt(0)));
    file.sha = 'sha' + (Number(file.sha.slice(3)) + 1);
    return ok({ content: { sha: file.sha } });
  }
  if (url.endsWith('/repos/me/data')) return ok({ default_branch: 'main' });
  if (url.includes('/git/ref/heads/main')) {
    if (init.headers?.['If-None-Match'] === '"e1"') return new Response(null, { status: 304 });
    return new Response(JSON.stringify({ object: { sha: headSha } }), { status: 200, headers: { ETag: '"e1"' } });
  }
  if (url.includes('/git/commits/') && (init.method ?? 'GET') === 'GET') return ok({ tree: { sha: 't0' } });
  if (url.endsWith('/git/trees') && init.method === 'POST') { treeBody = JSON.parse(init.body); return ok({ sha: 't1' }); }
  if (url.endsWith('/git/commits') && init.method === 'POST') { commitBody = JSON.parse(init.body); return ok({ sha: 'c1' }, 201); }
  if (url.includes('/git/refs/heads/main') && init.method === 'PATCH') return ok({}, patchFails > 0 && patchFails-- ? 422 : 200);
  if (url.includes('/commits?')) return ok([{ sha: 'c9', commit: { message: 'Second\n\nbody', author: { name: 'Ann', date: '2026-01-02T00:00:00Z' } } }, { sha: 'c8', commit: { message: 'First', author: { name: 'Ann', date: '2026-01-01T00:00:00Z' } }, author: { login: 'ann' } }]);
  if (url.includes('/compare/')) return ok({ commits: [{ sha: 'c5' }, { sha: 'c6' }], files: [{ filename: 'notes-app/a.txt', status: 'modified' }, { filename: 'notes-app/new.txt', status: 'added' }, { filename: 'notes-app/gone.txt', status: 'removed' }, { filename: 'other/x.txt', status: 'modified' }] });
  if (url.endsWith('/generate') && init.method === 'POST') {
    const b = JSON.parse(init.body);
    if (b.name === 'taken') return ok({}, 422);
    return ok({ full_name: `me/${b.name}`, default_branch: 'main', echo: b }, 201);
  }
  if (url.endsWith('/user/repos') && init.method === 'POST') {
    const b = JSON.parse(init.body);
    if (b.name === 'taken') return ok({}, 422);
    if (b.name === 'denied') return ok({}, 403);
    return ok({ full_name: `me/${b.name}`, default_branch: 'main', echo: b });
  }
  if (url.endsWith('/contents/notes-app')) return ok([{ name: 'a.txt', path: 'notes-app/a.txt', type: 'file', sha: 's', size: 3, extra: 1 }, { name: 'sub', path: 'notes-app/sub', type: 'dir', sha: 'd', size: 0 }]);
  if (url.endsWith('/contents/empty')) return ok({}, 404);
  if (url.includes('/contents/') && init.headers?.['If-None-Match'] === '"v1"') return new Response(null, { status: 304 });
  if (url.includes('/contents/') && init.method === 'DELETE') return JSON.parse(init.body).sha === file.sha ? ok({}) : ok({}, 409);
  if (url.includes('/contents/notes-app/missing')) return ok({}, 404);
  if (url.includes('/contents/')) return new Response(JSON.stringify({ sha: file.sha, content: btoa(String.fromCharCode(...new TextEncoder().encode(file.text))) }), { status: 200, headers: { ETag: '"v1"' } });
  return ok({}, 500);
};

let fails = 0;
const check = (n, ok) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${n}`); if (!ok) fails++; };
const gh = createClient({ clientId: 'Iv1.x', relay: 'https://relay.example/', appSlug: 'my-app', folder: '/notes-app/', fetchImpl });

await gh.signIn();
const q = new URL(L.went).searchParams;
check('signIn: PKCE challenge and client id', q.get('code_challenge_method') === 'S256' && q.get('client_id') === 'Iv1.x' && q.get('code_challenge').length === 43);
const state = q.get('state');
loc = `https://me.github.io/app/?code=abc&state=${state}`;
check('handleReturn: signs in', (await gh.handleReturn())?.login === 'me' && (await gh.signedIn()) && (await gh.login()) === 'me' && loc === 'https://me.github.io/app/');
check('handleReturn: verifier sent to relay', JSON.parse(calls.find((c) => c.url.endsWith('/token')).init.body).code_verifier.length === 64);
loc = 'https://me.github.io/app/?code=abc&state=wrong';
sessionStorage.setItem('gh-store:pending', JSON.stringify({ verifier: 'v', state: 'right', redirect: 'x' }));
await gh.handleReturn().then(() => check('wrong state refused', false), () => check('wrong state refused', true));
check('installUrl carries state', gh.installUrl() === 'https://github.com/apps/my-app/installations/new?state=' + encodeURIComponent('https://me.github.io/app/'));
check('repos', JSON.stringify(await gh.repos()) === '[{"full":"me/data","branch":"main"}]');
const f = await gh.read('me/data', 'a.txt');
check('read: utf-8 and sha', f.text === 'héllo' && f.sha === 'sha1');
check('read: etag returned, path under the folder', f.etag === '"v1"' && calls.at(-1).url.endsWith('/contents/notes-app/a.txt'));
check('read: 304 gives notModified', (await gh.read('me/data', 'a.txt', undefined, '"v1"')).notModified === true);
check('list: entries trimmed', JSON.stringify((await gh.list('me/data', '')).map((x) => [x.name, x.type])) === '[["a.txt","file"],["sub","dir"]]');
const made = await gh.createRepo('fresh', { description: 'x' });
const sent = JSON.parse(calls.findLast((c) => c.url.endsWith('/user/repos')).init.body);
check('createRepo: private with an initial commit', made.full === 'me/fresh' && made.branch === 'main' && sent.private === true && sent.auto_init === true && sent.name === 'fresh');
await gh.createRepo('taken').then(() => check('createRepo: name taken', false), (e) => check('createRepo: name taken', /already exists/.test(e.message)));
await gh.createRepo('denied').then(() => check('createRepo: permission missing', false), (e) => check('createRepo: permission missing', /Repository creation/.test(e.message)));
const wm = await gh.writeMany('me/data', { 'a.txt': 'A', 'old.txt': null }, { message: 'Two files' });
check('writeMany: one tree with a path under the folder, a delete as sha null', wm.commit === 'c1' && treeBody.base_tree === 't0' && treeBody.tree[0].path === 'notes-app/a.txt' && treeBody.tree[0].content === 'A' && treeBody.tree[1].sha === null && commitBody.parents[0] === 'h1' && commitBody.message === 'Two files');
patchFails = 1;
check('writeMany: starts again when the branch moved', (await gh.writeMany('me/data', { 'a.txt': 'B' })).commit === 'c1' && patchFails === 0);
patchFails = 1;
await gh.writeMany('me/data', { 'a.txt': 'B' }, { base: 'h1' }).then(() => check('writeMany: base moved gives Conflict', false), (e) => check('writeMany: base moved gives Conflict', e instanceof Conflict));
await gh.writeMany('me/data', { 'a.txt': 'B' }, { base: 'stale' }).then(() => check('writeMany: base not the head gives Conflict', false), (e) => check('writeMany: base not the head gives Conflict', e instanceof Conflict));
const hist = await gh.history('me/data', 'a.txt');
check('history: newest first, first line of the message', hist.length === 2 && hist[0].sha === 'c9' && hist[0].message === 'Second' && hist[1].author === 'Ann' && /path=notes-app%2Fa.txt/.test(calls.findLast((c) => c.url.includes('/commits?')).url));
const hd = await gh.head('me/data');
check('head: sha and etag', hd.sha === 'h1' && hd.etag === '"e1"');
check('head: 304 gives notModified', (await gh.head('me/data', 'main', '"e1"')).notModified === true);
const ch = await gh.changes('me/data', 'c4');
check('changes: only the folder, relative paths, new head', JSON.stringify(ch.files) === '[{"path":"a.txt","status":"modified"},{"path":"new.txt","status":"added"},{"path":"gone.txt","status":"removed"}]' && ch.head === 'c6' && ch.truncated === false);
const tr = await gh.createRepoFromTemplate('tpl/starter', 'mine', { description: 'd' });
check('createRepoFromTemplate: private by default, returns the repo', tr.full === 'me/mine' && tr.branch === 'main' && JSON.parse(calls.findLast((c) => c.url.endsWith('/generate')).init.body).private === true);
await gh.createRepoFromTemplate('tpl/starter', 'taken').then(() => check('createRepoFromTemplate: name taken', false), (e) => check('createRepoFromTemplate: name taken', /already exists/.test(e.message)));
check('read: missing is null', (await gh.read('me/data', 'missing.txt')) === null);
const s2 = await gh.write('me/data', 'a.txt', 'wörld', f.sha);
check('write: new sha, text stored, under the folder', s2 === 'sha2' && file.text === 'wörld' && calls.at(-1).url.endsWith('/contents/notes-app/a.txt'));
await gh.write('me/data', 'a.txt', 'x', f.sha).then(() => check('stale sha throws Conflict', false), (e) => check('stale sha throws Conflict', e instanceof Conflict));
await gh.remove('me/data', 'a.txt', 'old').then(() => check('remove: stale sha throws Conflict', false), (e) => check('remove: stale sha throws Conflict', e instanceof Conflict));
check('remove: ok', (await gh.remove('me/data', 'a.txt', s2)) === true);
const a = JSON.parse(store.get('gh-store:auth'));
a.expiresAt = Date.now() + 1000;
store.set('gh-store:auth', JSON.stringify(a));
check('token: refreshed near expiry', (await gh.token()) === 'ghu_2');
await gh.signOut();
check('signOut', !(await gh.signedIn()) && (await gh.token()) === null);

const mem2 = new Map();
const gh2 = createClient({ clientId: 'Iv1.x', relay: 'https://relay.example/', appSlug: 'x', fetchImpl, cleanUrl: () => '/app/#/settings',
  storage: { get: async () => mem2.get('a') ?? null, set: async (v) => mem2.set('a', v), del: async () => mem2.delete('a') } });
await gh2.signIn();
loc = `https://me.github.io/app/?code=abc&state=${new URL(L.went).searchParams.get('state')}`;
await gh2.handleReturn();
check('custom storage and cleanUrl', mem2.get('a')?.access === 'ghu_1' && loc === 'https://me.github.io/app/#/settings' && (await gh2.auth()).login === 'me');
mem2.get('a').expiresAt = 0;
const toks = await Promise.all([gh2.token(), gh2.token()]);
check('token: concurrent refreshes share one request', toks[0] === 'ghu_2' && toks[1] === 'ghu_2' && calls.filter((c) => c.url.endsWith('/refresh')).length === 2);

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
