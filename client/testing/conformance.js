// The contract every host adapter must keep, as tests. The same scenarios run against the fake server of every host, so a host that
// behaves differently from the others fails here, and so does an adapter that does not check what the host sends back.
//
//   runConformance(adapterId, makeFake, { test, assert })
//
// `test(name, fn)` registers one scenario. The scenarios only use the store (fetch, read, commit, ensureBranch, repoInfo) and the
// fake's arrange-and-assert helpers (seed, commitElsewhere, files, head, commitCount). The contract, in words:
//
//  fetch()      { revision, files: { path: contentId } }. revision is the head commit, or null for a repo with no commits. Equal content has
//               equal ids. All files are listed, however many pages the host needs. A missing repo is NotFound, never "empty".
//  read(id)     the exact text: empty files, unicode and CRLF included.
//  commit()     one commit for all changes (create, update, delete), based on the revision you pass. If the branch is no longer there it
//               throws Conflict. Deleting a file that is not there is ignored. No change means no commit. Works without a fetch first.
//               The first commit of an empty repo is Unsupported (capabilities.createOnEmpty is false on every host).
//               A commit that loses a race with someone else is refused as the host's capabilities.concurrency says.
//  folder       only that folder is seen, with paths relative to it, and writes go inside it.
//  ensureBranch the branch is created from the default branch when missing; true if created, false if it was there.
//  errors       wrong token: Unauthorized. Missing repo: NotFound. No network: HostUnreachable. Slow down: RateLimited.
//               An answer of the wrong shape on any call the adapter reads: ApiMismatch, naming the call.

import { ApiMismatch, Conflict, HostUnreachable, NotFound, RateLimited, Unauthorized, Unsupported } from '../hosts/errors.js';
import { createStore } from '../hosts/index.js';

export function runConformance(id, makeFake, { test, assert }) {
  const t = (name, fn) => test(`${id}: ${name}`, fn);
  const setup = () => {
    const server = makeFake();
    const mk = (o = {}) => createStore(id, { repo: server.repo, origin: server.origin, token: 'tok', fetch: server.fetch, branch: 'main', ...o });
    return { server, mk };
  };
  const rejects = (promise, type) => assert.rejects(promise, (e) => { assert.ok(e instanceof type, `expected ${type.name}, got ${e?.name}: ${e?.message}`); return true; });

  t('an empty repo has no revision and no files', async () => {
    const { mk } = setup();
    assert.deepEqual(await mk().fetch(), { revision: null, files: {} });
  });

  t('a missing repo is NotFound, not an empty repo', async () => {
    const { server, mk } = setup();
    server.repoMissing = true;
    await rejects(mk().fetch(), NotFound);
  });

  t('a wrong token is Unauthorized', async () => {
    const { server, mk } = setup();
    server.requireToken = 'secret';
    await rejects(mk({ token: 'wrong' }).fetch(), Unauthorized);
  });

  t('repoInfo gives the default branch and whether the token may write', async () => {
    const { server, mk } = setup();
    assert.deepEqual(await mk().repoInfo(), { defaultBranch: 'main', canWrite: true });
    server.canWrite = false;
    assert.equal((await mk().repoInfo()).canWrite, false);
  });

  t('fetch lists nested files with ids, and read returns their text', async () => {
    const { server, mk } = setup();
    const head = server.seed({ 'a.txt': 'one', 'dir/b.txt': 'two', 'sp ace/ü.txt': 'three' });
    const store = mk();
    const snap = await store.fetch();
    assert.equal(snap.revision, head);
    assert.deepEqual(Object.keys(snap.files).sort(), ['a.txt', 'dir/b.txt', 'sp ace/ü.txt']);
    assert.equal(await store.read(snap.files['dir/b.txt']), 'two');
    assert.equal(await store.read(snap.files['sp ace/ü.txt']), 'three');
  });

  t('equal content has equal ids', async () => {
    const { server, mk } = setup();
    server.seed({ 'p.txt': 'same', 'q.txt': 'same', 'r.txt': 'other' });
    const { files } = await mk().fetch();
    assert.equal(files['p.txt'], files['q.txt']);
    assert.notEqual(files['p.txt'], files['r.txt']);
  });

  t('every file is listed when the host needs several pages', async () => {
    const { server, mk } = setup();
    const many = {};
    for (let i = 0; i < 250; i++) many[`f/${String(i).padStart(3, '0')}.txt`] = `text ${i}`;
    server.seed(many);
    assert.equal(Object.keys((await mk().fetch()).files).length, 250);
  });

  t('commit creates, updates and deletes in one commit', async () => {
    const { server, mk } = setup();
    server.seed({ 'a.txt': 'A', 'b.txt': 'B' });
    const store = mk();
    const before = server.commitCount();
    const { revision } = await store.fetch();
    const next = await store.commit(revision, { 'a.txt': 'A2', 'b.txt': null, 'c.txt': 'C' }, 'sync');
    assert.deepEqual(server.files(), { 'a.txt': 'A2', 'c.txt': 'C' });
    assert.equal(server.commitCount(), before + 1);
    assert.equal(next, server.head());
    assert.equal((await store.fetch()).revision, next);
  });

  t('deleting a file that is not there is ignored', async () => {
    const { server, mk } = setup();
    server.seed({ 'a.txt': 'A' });
    const store = mk();
    const { revision } = await store.fetch();
    await store.commit(revision, { 'nope.txt': null, 'x.txt': 'X' });
    assert.deepEqual(server.files(), { 'a.txt': 'A', 'x.txt': 'X' });
  });

  t('no change means no commit', async () => {
    const { server, mk } = setup();
    server.seed({ 'a.txt': 'A' });
    const store = mk();
    const { revision } = await store.fetch();
    const before = server.commitCount();
    assert.equal(await store.commit(revision, { 'nope.txt': null }), revision);
    assert.equal(server.commitCount(), before);
  });

  t('a commit based on an old revision is a Conflict, and works after a new fetch', async () => {
    const { server, mk } = setup();
    server.seed({ 'a.txt': 'A' });
    const store = mk();
    const { revision } = await store.fetch();
    server.commitElsewhere({ 'o.txt': 'O' });
    await rejects(store.commit(revision, { 'n.txt': 'N' }), Conflict);
    assert.deepEqual(server.files(), { 'a.txt': 'A', 'o.txt': 'O' });
    const fresh = await store.fetch();
    await store.commit(fresh.revision, { 'n.txt': 'N' });
    assert.deepEqual(server.files(), { 'a.txt': 'A', 'o.txt': 'O', 'n.txt': 'N' });
  });

  // Someone commits between our head check and the host call. What must happen depends on what the host can check (capabilities.concurrency).
  t('a commit that loses a race is refused according to the host\'s concurrency rule', async () => {
    const { server, mk } = setup();
    server.seed({ 'a.txt': 'A', 'b.txt': 'B' });
    const store = mk();
    const { revision } = await store.fetch();
    if (store.capabilities.concurrency === 'branch') {
      server.beforeWrite = () => server.commitElsewhere({ 'other.txt': 'O' });
      await rejects(store.commit(revision, { 'a.txt': 'mine' }), Conflict);
      assert.deepEqual(server.files(), { 'a.txt': 'A', 'b.txt': 'B', 'other.txt': 'O' });
    } else {
      assert.equal(store.capabilities.concurrency, 'files');
      // the same file changed in between: refused, nothing of ours is written
      server.beforeWrite = () => server.commitElsewhere({ 'a.txt': 'theirs' });
      await rejects(store.commit(revision, { 'a.txt': 'mine', 'b.txt': 'B2' }), Conflict);
      assert.deepEqual(server.files(), { 'a.txt': 'theirs', 'b.txt': 'B' });
      // a different file changed in between: no false conflict, both changes are there
      const fresh = await store.fetch();
      server.beforeWrite = () => server.commitElsewhere({ 'other.txt': 'O' });
      await store.commit(fresh.revision, { 'a.txt': 'mine' });
      assert.deepEqual(server.files(), { 'a.txt': 'mine', 'b.txt': 'B', 'other.txt': 'O' });
    }
  });

  t('commit works on a store that has not fetched, and treats an existing file as an update', async () => {
    const { server, mk } = setup();
    const head = server.seed({ 'a.txt': 'A', 'd.txt': 'D' });
    await mk().commit(head, { 'a.txt': 'changed', 'd.txt': null, 'new.txt': 'N' });
    assert.deepEqual(server.files(), { 'a.txt': 'changed', 'new.txt': 'N' });
  });

  t('empty files, unicode and CRLF come back exactly', async () => {
    const { server, mk } = setup();
    server.seed({ 'keep.txt': 'k' });
    const store = mk();
    const { revision } = await store.fetch();
    const texts = { 'e.txt': '', 'u.txt': 'héllo ✓ 日本\r\nline two\n', 'n.txt': '\n' };
    await store.commit(revision, texts);
    const { files } = await store.fetch();
    for (const [path, text] of Object.entries(texts)) assert.equal(await store.read(files[path]), text, path);
  });

  t('a folder is the whole world of the store', async () => {
    const { server, mk } = setup();
    server.seed({ 'app/a.txt': '1', 'other/b.txt': '2' });
    const store = mk({ folder: 'app/' });
    const snap = await store.fetch();
    assert.deepEqual(Object.keys(snap.files), ['a.txt']);
    await store.commit(snap.revision, { 'n.txt': 'new', 'a.txt': null });
    assert.deepEqual(server.files(), { 'app/n.txt': 'new', 'other/b.txt': '2' });
  });

  t('the first commit of an empty repo is Unsupported, and the capability says so', async () => {
    const { mk } = setup();
    const store = mk();
    assert.equal(store.capabilities.createOnEmpty, false);
    await rejects(store.commit(null, { 'a.txt': 'A' }), Unsupported);
  });

  t('ensureBranch creates a missing branch from the default one', async () => {
    const { server, mk } = setup();
    server.seed({ 'a.txt': 'A' });
    const store = mk({ branch: 'u/anna' });
    assert.equal(await store.ensureBranch(), true);
    assert.deepEqual(Object.keys((await store.fetch()).files), ['a.txt']);
    assert.equal(await store.ensureBranch(), false);
    assert.equal(await mk().ensureBranch(), false);
    const { revision } = await store.fetch();
    await store.commit(revision, { 'mine.txt': 'M' });
    assert.deepEqual(server.files('main'), { 'a.txt': 'A' }); // the default branch is untouched
    assert.deepEqual(server.files('u/anna'), { 'a.txt': 'A', 'mine.txt': 'M' });
  });

  t('ensureBranch starts a new branch from the one asked for when it exists', async () => {
    const { server, mk } = setup();
    server.seed({ 'a.txt': 'A' });
    server.seed({ 'a.txt': 'A', 'template.txt': 'T' }, 'template');
    assert.equal(await mk({ branch: 'u/anna' }).ensureBranch({ from: 'template' }), true);
    assert.deepEqual(server.files('u/anna'), { 'a.txt': 'A', 'template.txt': 'T' });
    assert.equal(await mk({ branch: 'u/bob' }).ensureBranch({ from: 'nope' }), true); // no such branch: the default one
    assert.deepEqual(server.files('u/bob'), { 'a.txt': 'A' });
  });

  t('ensureBranch on a repo with no commits is Unsupported', async () => {
    const { mk } = setup();
    await rejects(mk({ branch: 'u/anna' }).ensureBranch(), Unsupported);
  });

  t('no network is HostUnreachable and mentions CORS', async () => {
    const { server, mk } = setup();
    server.down = true;
    await assert.rejects(mk().fetch(), (e) => e instanceof HostUnreachable && /CORS/.test(e.message));
  });

  t('a rate limit is RateLimited', async () => {
    const { server, mk } = setup();
    server.rateLimit = true;
    await rejects(mk().fetch(), RateLimited);
  });

  // An answer of the wrong shape must be named, not crash somewhere later. Every route whose answer the adapter reads gets broken in turn.
  const probeServer = makeFake();
  for (const route of probeServer.routes.filter((r) => !probeServer.unread.includes(r))) {
    t(`a changed answer from "${route}" is an ApiMismatch that names the call`, async () => {
      const { server, mk } = setup();
      server.seed({ 'a.txt': 'A' });
      server.breakRoute(route);
      const main = mk();
      try {
        await main.repoInfo();
        const snap = await main.fetch();
        await main.read(Object.values(snap.files)[0]);
        await mk({ branch: 'u/anna' }).ensureBranch();
        await main.commit(snap.revision, { 'a.txt': 'changed', 'z.txt': 'Z' }, 'm');
      } catch (e) {
        assert.ok(e instanceof ApiMismatch, `${route}: expected ApiMismatch, got ${e?.name}: ${e?.message}`);
        assert.ok(e.call && e.host === id && /client\/hosts\//.test(e.message), `${route}: the error must name the host, the call and the adapter file`);
        return;
      }
      assert.fail(`${route}: the adapter never used this route, or did not check its answer`);
    });
  }
}
