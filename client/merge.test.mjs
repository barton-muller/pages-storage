// Run: node client/merge.test.mjs
import assert from 'node:assert/strict';
import { merge3Keys, mergeRecords, mergeText, syncFiles } from './merge.js';
import { memoryStore, storeClient } from './store.js';
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
