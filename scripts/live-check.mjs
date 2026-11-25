// Checks an adapter against a REAL host. The conformance suite uses fakes written from the host's documentation; this is the
// check that the fakes (and so the adapters) match the real server. Run it after changing an adapter, and now and then.
//
//   node scripts/live-check.mjs https://gitlab.com/group/project.git            read only, works on a public repo
//   node scripts/live-check.mjs https://codeberg.org/you/data.git --token T --write
//
// With --write it makes a throwaway branch "pages-storage-live-check" from the default branch, writes, updates, reads back and
// deletes a file there, and runs a conflict. It never touches the default branch. Delete the branch afterwards if you like.
import assert from 'node:assert/strict';
import { storeFromUrl } from '../client/hosts/index.js';
import { Conflict } from '../client/hosts/errors.js';

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--') && a !== args[args.indexOf('--token') + 1]) ?? args[0];
const token = args.includes('--token') ? args[args.indexOf('--token') + 1] : process.env.GIT_TOKEN;
const write = args.includes('--write');
const ok = (m) => console.log(`ok   ${m}`);

const read = await storeFromUrl(url, { token, anonymous: !token });
const info = await read.repoInfo();
ok(`${read.label}: default branch "${info.defaultBranch}", canWrite=${info.canWrite}`);
const snap = await read.fetch();
ok(`fetch: revision ${snap.revision?.slice(0, 8)}, ${Object.keys(snap.files).length} files`);
for (const [path, id] of Object.entries(snap.files).slice(0, 3)) {
  const text = await read.read(id);
  ok(`read ${path}: ${text.length} characters`);
}
if (write) {
  assert.ok(token, '--write needs --token');
  const branch = 'pages-storage-live-check';
  const store = await storeFromUrl(url, { token, branch });
  ok(`ensureBranch: ${(await store.ensureBranch()) ? 'created' : 'existed'}`);
  let s = await store.fetch();
  const name = `live-check-${Date.now()}.txt`;
  const rev1 = await store.commit(s.revision, { [name]: 'one\r\néü ✓\n' }, 'live check: create');
  s = await store.fetch();
  assert.equal(s.revision, rev1);
  assert.equal(await store.read(s.files[name]), 'one\r\néü ✓\n');
  ok('create and read back');
  const rev2 = await store.commit(rev1, { [name]: 'two' }, 'live check: update');
  s = await store.fetch();
  assert.equal(await store.read(s.files[name]), 'two');
  ok('update');
  await assert.rejects(() => store.commit(rev1, { [name]: 'stale' }, 'live check: stale'), Conflict);
  ok('a commit on an old revision is a Conflict');
  await store.commit(rev2, { [name]: null }, 'live check: delete');
  s = await store.fetch();
  assert.ok(!(name in s.files));
  ok('delete');
}
console.log('live check passed');
