// Run: node client/merge.test.mjs
import assert from 'node:assert/strict';
import { merge3Keys, mergeRecords, mergeText, syncFiles } from './merge.js';
import { memoryStore, forgejoStore, githubStore, storeClient } from './store.js';
import { Conflict } from './conflict.js';

let n = 0;
const test = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error('FAIL', name, e); process.exitCode = 1; } };

await test('merge3Keys: a change on one side wins over no change on the other', () => {
  assert.deepEqual(merge3Keys({ a: 1, b: 1 }, { a: 2, b: 1 }, { a: 1, b: 3 }), { a: 2, b: 3 });
});
await test('merge3Keys: both changed goes to local, or remote when asked', () => {
  assert.deepEqual(merge3Keys({ a: 1 }, { a: 2 }, { a: 3 }), { a: 2 });
  assert.deepEqual(merge3Keys({ a: 1 }, { a: 2 }, { a: 3 }, { preferRemote: true }), { a: 3 });
});
await test('merge3Keys: a key only one side has is kept; no remote keeps local; objects compare by value', () => {
  assert.deepEqual(merge3Keys(null, { a: 1 }, { b: { x: [1] } }), { a: 1, b: { x: [1] } });
  assert.deepEqual(merge3Keys(null, { a: 1 }, null), { a: 1 });
  assert.deepEqual(merge3Keys({ o: { x: 1 } }, { o: { x: 1 } }, { o: { x: 2 } }), { o: { x: 2 } });
});
await test('mergeRecords: newest wins, tombstones win over older records, ties go to local', () => {
  const l = { a: { updatedAt: '2', name: 'local' }, b: { updatedAt: '1', name: 'old' }, c: { updatedAt: '5', deleted: true } };
  const r = { a: { updatedAt: '2', name: 'remote' }, b: { updatedAt: '3', name: 'new' }, c: { updatedAt: '4', name: 'alive' }, d: { updatedAt: '1' } };
  assert.deepEqual(mergeRecords(l, r), { a: l.a, b: r.b, c: l.c, d: r.d });
  assert.deepEqual(mergeRecords(mergeRecords(l, r), r), mergeRecords(l, r));
});
await test('mergeText: the rules for one file', () => {
  assert.equal(mergeText('p', 'a', 'b', 'a'), 'b'); // only local changed
  assert.equal(mergeText('p', 'a', 'a', 'c'), 'c'); // only remote changed
  assert.equal(mergeText('p', 'a', 'b', 'c'), 'b'); // both: local
  assert.equal(mergeText('p', 'a', undefined, 'a'), null); // deleted here
  assert.equal(mergeText('p', 'a', 'a', undefined), null); // deleted there
  assert.equal(mergeText('p', 'a', undefined, 'c'), 'c'); // changed there beats deleted here
  assert.equal(mergeText('p', undefined, 'b', undefined), 'b'); // new here
});

await test('syncFiles: two devices converge through a store', async () => {
  const store = memoryStore();
  const A = { files: { 'plan.json': '{"a":1}' }, base: null };
  const B = { files: {}, base: null };
  const a1 = await syncFiles(store, A); A.files = a1.files; A.base = a1.base;
  const b1 = await syncFiles(store, B); B.files = b1.files; B.base = b1.base;
  assert.equal(B.files['plan.json'], '{"a":1}');
  B.files['b.txt'] = 'from b';
  A.files['plan.json'] = '{"a":2}';
  const b2 = await syncFiles(store, B); B.files = b2.files; B.base = b2.base;
  const a2 = await syncFiles(store, A); A.files = a2.files; A.base = a2.base;
  const b3 = await syncFiles(store, B); B.files = b3.files; B.base = b3.base;
  assert.deepEqual(A.files, B.files);
  assert.equal(A.files['b.txt'], 'from b');
  assert.equal(A.files['plan.json'], '{"a":2}');
  assert.deepEqual(store.files, A.files);
});
await test('syncFiles: nothing to do means no commit; a delete follows', async () => {
  const store = memoryStore();
  let s = await syncFiles(store, { files: { 'x.json': '1', 'y.json': '2' }, base: null });
  const before = (await store.fetch()).revision;
  s = await syncFiles(store, { files: s.files, base: s.base });
  assert.equal(s.revision, before);
  assert.deepEqual(s.pushed, []);
  const { 'y.json': _, ...rest } = s.files;
  s = await syncFiles(store, { files: rest, base: s.base });
  assert.deepEqual(Object.keys(store.files), ['x.json']);
  assert.deepEqual(s.pushed, ['y.json']);
});
await test('syncFiles: a commit that loses the race is merged again', async () => {
  const store = memoryStore();
  store.beforeCommit = () => store.commitElsewhere({ 'other.json': 'x' });
  const s = await syncFiles(store, { files: { 'mine.json': 'y' }, base: null });
  assert.deepEqual(s.files, { 'mine.json': 'y', 'other.json': 'x' });
  assert.deepEqual(store.files, { 'mine.json': 'y', 'other.json': 'x' });
});
await test('syncFiles: include leaves other files alone, merge can be per file', async () => {
  const store = memoryStore();
  await store.commitElsewhere({ 'app/s.json': '{"a":1}', 'other/z.txt': 'z' });
  const s = await syncFiles(store, {
    files: { 'app/s.json': '{"b":2}' }, base: null, include: (p) => p.startsWith('app/'),
    merge: (p, b, l, r) => JSON.stringify(merge3Keys(b && JSON.parse(b), l && JSON.parse(l), r && JSON.parse(r))),
  });
  assert.deepEqual(JSON.parse(s.files['app/s.json']), { a: 1, b: 2 });
  assert.equal(store.files['other/z.txt'], 'z');
  assert.ok(!('other/z.txt' in s.files));
});

await test('forgejoStore: fetch, read and commit speak the Forgejo API', async () => {
  const calls = [];
  const files = { 'fitness/a.gpx': { sha: 's1', text: 'AAA' } };
  let head = 'c1';
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body && JSON.parse(init.body), auth: init.headers?.Authorization });
    const ok = (b, status = 200) => new Response(JSON.stringify(b), { status });
    if (url.endsWith('/branches/main')) return ok({ commit: { id: head } });
    if (url.includes('/git/trees/')) return ok({ tree: Object.entries(files).map(([path, f]) => ({ path, type: 'blob', sha: f.sha })).concat([{ path: 'fitness', type: 'tree', sha: 't' }]) });
    if (url.includes('/git/blobs/s1')) return ok({ content: btoa('AAA'), encoding: 'base64' });
    if (url.endsWith('/contents') && init.method === 'POST') { head = 'c2'; return ok({ commit: { sha: 'c2' } }); }
    return ok({}, 404);
  };
  const store = forgejoStore({ url: 'https://codeberg.org/', repo: 'me/data', branch: 'main', token: 'tok', fetch: fetchImpl });
  const snap = await store.fetch();
  assert.deepEqual(snap, { revision: 'c1', files: { 'fitness/a.gpx': 's1' } });
  assert.equal(await store.read('s1'), 'AAA');
  const rev = await store.commit('c1', { 'fitness/a.gpx': 'BBB', 'fitness/b.gpx': 'new', 'fitness/gone.gpx': null }, 'msg');
  assert.equal(rev, 'c2');
  const post = calls.find((c) => c.method === 'POST');
  assert.equal(post.auth, 'token tok');
  assert.deepEqual(post.body.files.map((f) => [f.operation, f.path, f.sha]), [['update', 'fitness/a.gpx', 's1'], ['create', 'fitness/b.gpx', undefined]]);
  assert.equal(calls[0].url, 'https://codeberg.org/api/v1/repos/me/data/branches/main');
});
await test('forgejoStore: a moved branch is a Conflict; a missing branch is an empty repo', async () => {
  const fetchImpl = async (url) => url.endsWith('/branches/main') ? new Response(JSON.stringify({ commit: { id: 'c9' } })) : new Response('{}', { status: 404 });
  const store = forgejoStore({ url: 'https://x.test', repo: 'a/b', fetch: fetchImpl });
  await assert.rejects(() => store.commit('c1', { 'a.txt': 'x' }), Conflict);
  const none = forgejoStore({ url: 'https://x.test', repo: 'a/b', branch: 'nope', fetch: async () => new Response('{}', { status: 404 }) });
  assert.deepEqual(await none.fetch(), { revision: null, files: {} });
});
await test('githubStore: wraps the client calls', async () => {
  const calls = [];
  const client = {
    tree: async (r, b) => { calls.push(['tree', r, b]); return { head: 'h1', files: { 'a.json': 'x1' } }; },
    blob: async (r, id) => { calls.push(['blob', id]); return 'text'; },
    writeMany: async (r, ch, o) => { calls.push(['writeMany', ch, o]); return { commit: 'h2' }; },
  };
  const store = githubStore(client, 'me/data', { branch: 'main' });
  assert.deepEqual(await store.fetch(), { revision: 'h1', files: { 'a.json': 'x1' } });
  assert.equal(await store.read('x1'), 'text');
  assert.equal(await store.commit('h1', { 'a.json': 'new' }, 'm'), 'h2');
  assert.deepEqual(calls[2], ['writeMany', { 'a.json': 'new' }, { branch: 'main', message: 'm', base: 'h1' }]);
});

await test('storeClient: the GitHub client calls over any store', async () => {
  const store = memoryStore();
  await store.commitElsewhere({ 'a.txt': 'one', 'dir/b.txt': 'two' });
  const c = storeClient(store, 'me/data');
  assert.deepEqual((await c.list('me/data', '')).map((x) => [x.name, x.type]), [['dir', 'dir'], ['a.txt', 'file']]);
  assert.deepEqual((await c.list('me/data', 'dir')).map((x) => x.path), ['dir/b.txt']);
  const f = await c.read('me/data', 'a.txt');
  assert.equal(f.text, 'one');
  const sha = await c.write('me/data', 'a.txt', 'changed', f.sha);
  await assert.rejects(() => c.write('me/data', 'a.txt', 'stale', f.sha), Conflict);
  assert.equal((await c.read('me/data', 'a.txt')).sha, sha);
  assert.equal(await c.read('me/data', 'nope.txt'), null);
  assert.equal(await c.remove('me/data', 'a.txt', sha), true);
  assert.equal(await c.remove('me/data', 'a.txt', sha), false);
});

console.log(`${n} checks passed`);
