// Stores for syncFiles() in merge.js. A store is { fetch(), read(id), commit(expected, changes, message) } with a few more calls
// (repoInfo, ensureBranch) and two fields (host, capabilities); the contract is written out in docs/HOSTS.md.
//
//   storeFromUrl(url, { token, branch })    the store for a repo address, as copied for git clone: GitHub, GitLab, Forgejo, Gitea, Codeberg
//   githubStore(client, repo, { branch })   GitHub after sign-in with the relay, through the client from ghstore.js
//   memoryStore()                           in memory, for tests and demos
//   storeClient(store, label)               any store behind the read, write, list and remove calls of the GitHub client
//
// The code for each host is in hosts/ (one file per host, all running the same shared store), with errors in hosts/errors.js.
// A web page can only call servers that allow its origin (CORS): api.github.com, GitLab's API and Codeberg's API do. For a
// self-hosted server turn on CORS for the site. The git protocol itself is not callable from a page on these hosts.

import { Conflict } from './conflict.js';
import { createStore, hosts, storeFromUrl } from './hosts/index.js';

export { Conflict, createStore, hosts, storeFromUrl };
export { detectHost, parseRepoUrl } from './hosts/index.js';
export * from './hosts/errors.js';

export function memoryStore() {
  let revision = 0;
  const files = new Map(); // path -> { id, text }
  const texts = new Map(); // id -> text
  let n = 0;
  const store = {
    host: 'memory',
    capabilities: { createOnEmpty: true, concurrency: 'branch' },
    async repoInfo() { return { defaultBranch: 'main', canWrite: true }; },
    async ensureBranch() { return false; },
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

// GitHub after sign-in with the relay: the token comes from the client and is refreshed by it. Resolves to a store.
export const githubStore = (client, repo, { branch, folder = '', fetch } = {}) =>
  storeFromUrl(`https://github.com/${repo}`, { token: () => client.token(), branch, folder, ...(fetch ? { fetch } : {}) });

// One host with its address spelled out, for code that already knows which host it talks to. storeFromUrl finds this out itself.
export const githubTokenStore = ({ repo, branch = 'main', token, folder = '', fetch }) => createStore('github', { repo, token, branch, folder, ...(fetch ? { fetch } : {}) });
export const forgejoStore = ({ url, repo, branch = 'main', token, folder = '', fetch }) => createStore('forgejo', { repo, origin: url.replace(/\/+$/, ''), token, branch, folder, ...(fetch ? { fetch } : {}) });
export const gitlabStore = ({ url = 'https://gitlab.com', repo, branch = 'main', token, folder = '', fetch }) => createStore('gitlab', { repo, origin: url.replace(/\/+$/, ''), token, branch, folder, ...(fetch ? { fetch } : {}) });

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
