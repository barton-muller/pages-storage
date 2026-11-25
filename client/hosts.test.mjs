// Run: node client/hosts.test.mjs
// Every host adapter against its fake server with the same conformance suite, plus the address handling.
import assert from 'node:assert/strict';
import { createStore, hosts, detectHost, parseRepoUrl, storeFromUrl } from './hosts/index.js';
import { syncFiles } from './merge.js';
import { HostUnreachable, Unsupported } from './hosts/errors.js';
import { runConformance } from './testing/conformance.js';
import { fakes } from './testing/fakes/index.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// Adding a host means adding its fake and passing the suite: this keeps that from being forgotten.
test('every adapter has a fake server, and every fake an adapter', () => {
  assert.deepEqual(Object.keys(hosts).sort(), Object.keys(fakes).sort());
  for (const [id, h] of Object.entries(hosts)) {
    assert.equal(h.id, id);
    for (const key of ['label', 'known', 'repoPath', 'create', 'probe']) assert.ok(key in h, `${id} lacks ${key}`);
  }
});

for (const id of Object.keys(hosts)) runConformance(id, () => fakes[id](), { test, assert });

test('parseRepoUrl: the address as copied for git clone', () => {
  assert.deepEqual(parseRepoUrl('https://github.com/me/data.git'), { host: 'github.com', origin: 'https://github.com', segments: ['me', 'data'], token: undefined });
  assert.deepEqual(parseRepoUrl('https://gitlab.com/grp/sub/proj/').segments, ['grp', 'sub', 'proj']);
  assert.equal(parseRepoUrl('https://tok123@git.example.org/me/data.git').token, 'tok123');
  assert.equal(parseRepoUrl('https://user:tok456@git.example.org/me/data').token, 'tok456');
  assert.equal(parseRepoUrl('http://github.com/me/data'), null);
  assert.equal(parseRepoUrl('https://github.com/me'), null);
  assert.equal(parseRepoUrl('not a url'), null);
});

test('detectHost: known hosts need no request, others are probed, unknown ones are said so', async () => {
  const never = async () => { throw new Error('no request expected'); };
  assert.equal((await detectHost(parseRepoUrl('https://github.com/a/b'), never)).id, 'github');
  assert.equal((await detectHost(parseRepoUrl('https://gitlab.com/a/b'), never)).id, 'gitlab');
  assert.equal((await detectHost(parseRepoUrl('https://codeberg.org/a/b'), never)).id, 'forgejo');
  const gl = fakes.gitlab();
  const fj = fakes.forgejo();
  assert.equal((await detectHost(parseRepoUrl('https://git.example.org/me/data'), gl.fetch)).id, 'gitlab');
  assert.equal((await detectHost(parseRepoUrl('https://git.example.org/me/data'), fj.fetch)).id, 'forgejo');
  await assert.rejects(() => detectHost(parseRepoUrl('https://git.example.org/me/data'), async () => new Response('<html>', { status: 200 })), (e) => e instanceof Unsupported && /Supported: GitHub, GitLab, Forgejo or Gitea/.test(e.message));
  // no answer at all is not "unknown host": it is a host we could not reach
  await assert.rejects(() => detectHost(parseRepoUrl('https://git.example.org/me/data'), async () => { throw new TypeError('Failed to fetch'); }), (e) => e instanceof HostUnreachable && /CORS/.test(e.message));
});

test('storeFromUrl: the host picks the adapter, the default branch is looked up, a read-only token is refused', async () => {
  for (const [url, id, make] of [
    ['https://github.com/me/data.git', 'github', fakes.github],
    ['https://git.example.org/me/data.git', 'gitlab', fakes.gitlab],
    ['https://git.example.org/me/data.git', 'forgejo', fakes.forgejo],
  ]) {
    const server = make();
    server.seed({ 'a.txt': 'A' });
    const store = await storeFromUrl(url, { token: 'T', fetch: server.fetch });
    assert.equal(store.host, id);
    assert.deepEqual(Object.keys((await store.fetch()).files), ['a.txt']);
    server.canWrite = false;
    await assert.rejects(() => storeFromUrl(url, { token: 'T', fetch: server.fetch }), /write/);
  }
  await assert.rejects(() => storeFromUrl('https://github.com/me/data', {}), /token/);
});

test('storeFromUrl: a token inside the address works; GitLab allows subgroups, the others do not', async () => {
  const gl = fakes.gitlab('grp/sub/proj', 'https://gitlab.com');
  gl.seed({ 'a.txt': 'A' });
  const store = await storeFromUrl('https://tok@gitlab.com/grp/sub/proj.git', { fetch: gl.fetch });
  assert.equal(store.host, 'gitlab');
  assert.deepEqual(Object.keys((await store.fetch()).files), ['a.txt']);
  await assert.rejects(() => storeFromUrl('https://github.com/a/b/c', { token: 'T', fetch: fakes.github().fetch }), /owner\/name/);
});

// The merge engine over each host: two devices, one repo, the same result everywhere.
for (const id of Object.keys(hosts)) {
  test(`${id}: two devices converge through syncFiles`, async () => {
    const server = fakes[id]();
    server.seed({ 'app/readme.txt': 'hello' });
    const store = () => createStore(id, { repo: server.repo, origin: server.origin, token: 't', fetch: server.fetch, branch: 'main' });
    const inApp = (p) => p.startsWith('app/');
    const a = { files: { 'app/plan.json': '{"a":1}' }, base: null };
    const b = { files: {}, base: null };
    const sync = async (d) => { const r = await syncFiles(store(), { ...d, include: inApp }); d.files = r.files; d.base = r.base; return r; };
    await sync(a);
    await sync(b);
    assert.equal(b.files['app/plan.json'], '{"a":1}');
    assert.equal(b.files['app/readme.txt'], 'hello');
    b.files['app/b.txt'] = 'from b';
    a.files['app/plan.json'] = '{"a":2}';
    await sync(b);
    await sync(a);
    await sync(b);
    assert.deepEqual(a.files, b.files);
    assert.deepEqual(server.files(), a.files);
    assert.equal(a.files['app/plan.json'], '{"a":2}');
  });
}

let failed = 0;
for (const { name, fn } of tests) {
  try { await fn(); } catch (e) { failed++; console.error('FAIL', name, '\n ', e?.message ?? e); }
}
console.log(failed ? `${failed} of ${tests.length} failed` : `${tests.length} checks passed`);
process.exit(failed ? 1 : 0);
