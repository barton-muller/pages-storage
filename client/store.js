// Stores for syncFiles() in merge.js. A store is { fetch(), read(id), commit(expected, changes, message) }:
//   fetch()                          -> { revision, files: { path: id } }  (revision null while the repo is empty)
//   read(id)                         -> the text of a file
//   commit(expected, changes, msg)   -> the new revision. changes is { path: text | null }, null deletes.
//                                       Throws Conflict when the remote is no longer at `expected`.
//
//   githubStore(client, repo, { branch })           GitHub, through the client from ghstore.js (sign in with the relay)
//   forgejoStore({ url, repo, branch, token })      Forgejo, Gitea and Codeberg with an access token, no relay
//   memoryStore()                                   in memory, for tests and demos
//   storeClient(store, label)                       any store behind the read/write/list/remove calls of the GitHub client
//
// A web page can only call servers that allow its origin (CORS). api.github.com does, and so does Codeberg's API. For a
// self-hosted Forgejo or Gitea turn on [cors] in app.ini and list your site. Servers that do not (most git endpoints,
// and github.com's sign-in endpoints) need a relay or a native app.

import { Conflict } from './conflict.js';

const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const unb64 = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

export function memoryStore() {
  let revision = 0;
  const files = new Map(); // path -> { id, text }
  const texts = new Map(); // id -> text
  let n = 0;
  const store = {
    // Runs once, right before the next commit is checked. Lets a test move the remote at the worst moment.
    beforeCommit: null,
    async fetch() {
      return { revision: revision ? `r${revision}` : null, files: Object.fromEntries([...files].map(([p, f]) => [p, f.id])) };
    },
    async read(id) { return texts.get(id); },
    async commit(expected, changes) {
      if (store.beforeCommit) { const f = store.beforeCommit; store.beforeCommit = null; await f(); }
      if ((revision ? `r${revision}` : null) !== expected) throw new Conflict();
      for (const [path, text] of Object.entries(changes)) {
        if (text === null) files.delete(path);
        else { const id = `b${++n}`; texts.set(id, text); files.set(path, { id, text }); }
      }
      revision++;
      return `r${revision}`;
    },
    // A commit by somebody else.
    async commitElsewhere(changes) { return store.commit(revision ? `r${revision}` : null, changes); },
    get files() { return Object.fromEntries([...files].map(([p, f]) => [p, f.text])); },
  };
  return store;
}

export function githubStore(client, repo, { branch, message = 'Sync' } = {}) {
  return {
    async fetch() {
      const t = await client.tree(repo, branch);
      return { revision: t.head, files: t.files };
    },
    read: (id) => client.blob(repo, id),
    async commit(expected, changes, msg = message) {
      if (!expected) throw new Error('The repo has no commits yet. Create it with an initial commit.');
      return (await client.writeMany(repo, changes, { branch, message: msg, base: expected })).commit;
    },
  };
}

export function forgejoStore({ url, repo, branch = 'main', token, fetch: fetchImpl = (...a) => fetch(...a), folder = '' }) {
  const api = `${url.replace(/\/+$/, '')}/api/v1/repos/${repo}`;
  const pre = folder.replace(/^\/+|\/+$/g, '');
  const prefix = pre ? `${pre}/` : '';
  const call = (path, init = {}) =>
    fetchImpl(`${api}${path}`, { ...init, cache: 'no-store', headers: { Accept: 'application/json', ...(token ? { Authorization: `token ${token}` } : {}), ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers } });
  let last = { revision: null, files: {} }; // the files of the last fetch, whose ids the next commit needs
  const store = {
    async fetch() {
      const b = await call(`/branches/${encodeURIComponent(branch)}`);
      if (b.status === 404) return (last = { revision: null, files: {} });
      if (!b.ok) throw new Error(`${url} ${b.status}`);
      const head = (await b.json()).commit.id;
      const files = {};
      for (let page = 1; ; page++) {
        const r = await call(`/git/trees/${head}?recursive=true&per_page=1000&page=${page}`);
        if (!r.ok) throw new Error(`${url} ${r.status}`);
        const j = await r.json();
        for (const e of j.tree ?? []) if (e.type === 'blob' && e.path.startsWith(prefix)) files[e.path.slice(prefix.length)] = e.sha;
        if (!(j.tree?.length >= 1000) && !j.truncated) break;
        if (!j.tree?.length) break;
      }
      return (last = { revision: head, files });
    },
    async read(id) {
      const r = await call(`/git/blobs/${id}`);
      if (!r.ok) throw new Error(`${url} ${r.status}`);
      return unb64((await r.json()).content);
    },
    async commit(expected, changes, message = 'Sync') {
      const b = await call(`/branches/${encodeURIComponent(branch)}`);
      const head = b.status === 404 ? null : b.ok ? (await b.json()).commit.id : (() => { throw new Error(`${url} ${b.status}`); })();
      if (head !== expected) throw new Conflict();
      if (last.revision !== expected) await store.fetch();
      const ops = Object.entries(changes).map(([path, text]) => {
        const id = last.files[path];
        if (text === null) return id ? { operation: 'delete', path: prefix + path, sha: id } : null;
        return id ? { operation: 'update', path: prefix + path, content: b64(text), sha: id } : { operation: 'create', path: prefix + path, content: b64(text) };
      }).filter(Boolean);
      if (!ops.length) return expected;
      const r = await call('/contents', { method: 'POST', body: JSON.stringify({ branch, message, files: ops }) });
      if (r.status === 409 || r.status === 422) throw new Conflict();
      if (!r.ok) throw new Error(`${url} ${r.status}`);
      return (await r.json()).commit.sha;
    },
  };
  return store;
}

// Any store as a client with the read, write, list and remove calls of ghstore.js, so code written for that client (such as the
// example page) works with Forgejo, Gitea and Codeberg too. A "sha" is the file's content id. There is no history.
export function storeClient(store, label = 'repo') {
  const dirPrefix = (dir) => (dir ? `${dir.replace(/^\/+|\/+$/g, '')}/` : '');
  return {
    async handleReturn() { return null; },
    async signedIn() { return true; },
    async login() { return label; },
    async signOut() {},
    signIn() {},
    installUrl: () => '#',
    async repos() { return [{ full: label, branch: '' }]; },
    async list(_repo, dir = '') {
      const pre = dirPrefix(dir);
      const found = new Map();
      for (const [path, id] of Object.entries((await store.fetch()).files)) {
        if (!path.startsWith(pre)) continue;
        const rest = path.slice(pre.length);
        const slash = rest.indexOf('/');
        if (slash < 0) found.set(rest, { name: rest, path, type: 'file', sha: id });
        else found.set(rest.slice(0, slash), { name: rest.slice(0, slash), path: pre + rest.slice(0, slash), type: 'dir', sha: '' });
      }
      return [...found.values()].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    },
    async read(_repo, path, sha) {
      if (sha) return store.read(sha).then((text) => ({ text, sha }), () => null);
      const id = (await store.fetch()).files[path];
      return id ? { text: await store.read(id), sha: id, etag: null } : null;
    },
    async write(_repo, path, text, sha, _branch, message = 'Update') {
      const snap = await store.fetch();
      if (snap.files[path] !== (sha || undefined)) throw new Conflict();
      await store.commit(snap.revision, { [path]: text }, message);
      return (await store.fetch()).files[path];
    },
    async remove(_repo, path, sha, _branch, message = 'Delete') {
      const snap = await store.fetch();
      if (!snap.files[path]) return false;
      if (snap.files[path] !== sha) throw new Conflict();
      await store.commit(snap.revision, { [path]: null }, message);
      return true;
    },
    async history() { return []; },
  };
}
