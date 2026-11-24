// Browser client for "GitHub as storage": sign in through the relay, then read and write files in the
// repos the person installed your GitHub App on. No dependencies. Needs a browser (fetch, crypto, localStorage).
//
//   const gh = createClient({ clientId, relay, appSlug });
//   await gh.handleReturn();                  // call on every page load
//   if (!(await gh.signedIn())) gh.signIn();  // redirects to github.com and back
//   const repos = await gh.repos();           // [{ full, branch }], repos the app is installed on
//   const f = await gh.read(repo, 'notes.json');          // { text, sha, etag } or null
//   const g = await gh.read(repo, 'notes.json', undefined, f.etag);   // { notModified: true } when unchanged, and free of rate limit
//   const names = await gh.list(repo, '');                // [{ name, path, type, sha, size }] of the app's folder
//   await gh.writeMany(repo, { 'a.json': '{}', 'old.txt': null }, { message });   // several files in ONE commit, null deletes
//   const log = await gh.history(repo, 'a.json');         // [{ sha, message, author, date }] newest first; read(repo, path, sha) gives that version
//   const { head } = await gh.head(repo);                 // the branch's current commit; gh.changes(repo, oldHead) lists what changed since
//   await gh.write(repo, 'notes.json', text, f?.sha);     // returns the new sha; throws Conflict on a stale sha
//   await gh.remove(repo, 'notes.json', f.sha);           // true, or false if already gone

import { Conflict } from './conflict.js';
export { Conflict };

const API = 'https://api.github.com';
const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const unb64 = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
const url64 = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rand = (n) => url64(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => url64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
const SKEW = 5 * 60e3;

// folder: every path is kept under this folder of the repo, so several apps can share one repo ('my-app' -> my-app/notes.json).
// storage: where the sign-in is kept, { get(), set(value), del() }, each async. Defaults to localStorage under `<name>:auth`.
// cleanUrl: the address to show after sign-in returns, default the page's own path and hash.
export function createClient({ clientId, relay, appSlug, name = 'gh-store', folder = '', storage, cleanUrl = () => location.pathname + location.hash, fetchImpl = (...a) => fetch(...a) }) {
  const AUTH = `${name}:auth`;
  const PENDING = `${name}:pending`;
  const at = (path) => [folder.replace(/^\/+|\/+$/g, ''), path.replace(/^\/+/, '')].filter(Boolean).join('/');
  const here = () => location.origin + location.pathname;
  const store = storage ?? {
    get: async () => { try { return JSON.parse(localStorage.getItem(AUTH)); } catch { return null; } },
    set: async (a) => localStorage.setItem(AUTH, JSON.stringify(a)),
    del: async () => localStorage.removeItem(AUTH),
  };
  const load = () => Promise.resolve(store.get()).then((a) => a ?? null).catch(() => null);
  const save = (a) => Promise.resolve(store.set(a));
  let refreshing = null;
  const gh = (token, path, init = {}) =>
    fetchImpl(`${API}${path}`, { ...init, cache: 'no-store', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', ...init.headers } });

  async function viaRelay(path, body) {
    const r = await fetchImpl(`${relay.replace(/\/+$/, '')}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error(`Sign-in failed: ${j.error || r.status}`);
    const now = Date.now();
    return {
      access: j.access_token,
      expiresAt: now + (j.expires_in ?? 365 * 86400) * 1000,
      refresh: j.refresh_token ?? null,
      refreshExpiresAt: j.refresh_token_expires_in ? now + j.refresh_token_expires_in * 1000 : null,
    };
  }

  const api = {
    // The stored sign-in { login, access, expiresAt, refresh, refreshExpiresAt }, or null.
    auth: load,
    signedIn: async () => !!(await load()),
    login: async () => (await load())?.login ?? null,
    signOut: () => Promise.resolve(store.del()).catch(() => {}),

    // Opens GitHub. PKCE ties the returned code to this browser.
    async signIn() {
      const verifier = rand(48), state = rand(16);
      sessionStorage.setItem(PENDING, JSON.stringify({ verifier, state, redirect: here() }));
      const q = new URLSearchParams({ client_id: clientId, redirect_uri: here(), state, code_challenge: await sha256(verifier), code_challenge_method: 'S256' });
      location.assign(`https://github.com/login/oauth/authorize?${q}`);
    },

    // Call on every load. Finishes a sign-in when the URL holds ?code, and cleans the URL. Returns the new sign-in, or null.
    async handleReturn() {
      const q = new URLSearchParams(location.search);
      const clean = () => history.replaceState(null, '', cleanUrl());
      if (q.has('installation_id')) { clean(); return null; }
      if (!q.has('code') && !q.has('error')) return null;
      const raw = sessionStorage.getItem(PENDING);
      sessionStorage.removeItem(PENDING);
      const pending = raw ? JSON.parse(raw) : null;
      clean();
      if (q.has('error')) throw new Error(`GitHub: ${q.get('error_description') || q.get('error')}`);
      if (!pending || pending.state !== q.get('state')) throw new Error('Sign-in was not started in this browser. Try again.');
      const t = await viaRelay('/token', { code: q.get('code'), redirect_uri: pending.redirect, code_verifier: pending.verifier });
      const u = await gh(t.access, '/user');
      const a = { ...t, login: u.ok ? (await u.json()).login : 'GitHub user' };
      await save(a);
      return a;
    },

    // A valid access token, renewed through the relay shortly before it expires. Null when signed out.
    async token() {
      const a = await load();
      if (!a) return null;
      if (a.expiresAt - SKEW > Date.now()) return a.access;
      if (!a.refresh || (a.refreshExpiresAt && a.refreshExpiresAt < Date.now())) { await api.signOut(); return null; }
      refreshing ??= viaRelay('/refresh', { refresh_token: a.refresh })
        .then(async (t) => { const n = { ...t, login: a.login }; await save(n); return n; })
        .catch(() => null)
        .finally(() => { refreshing = null; });
      return (await refreshing)?.access ?? null;
    },

    // GitHub's page for choosing repos. state brings the person back to this page through the relay's /return route.
    installUrl: () => `https://github.com/apps/${appSlug}/installations/new?state=${encodeURIComponent(here())}`,

    async repos() {
      const t = await api.token();
      if (!t) throw new Error('Not signed in');
      const i = await gh(t, '/user/installations?per_page=100');
      if (!i.ok) throw new Error(`GitHub ${i.status}`);
      const out = [];
      for (const { id } of (await i.json()).installations) {
        const r = await gh(t, `/user/installations/${id}/repositories?per_page=100`);
        if (r.ok) for (const x of (await r.json()).repositories) out.push({ full: x.full_name, branch: x.default_branch });
      }
      return out;
    },

    // Creates a private repo for the signed-in person and returns { full, branch }. Needs the "Repository creation"
    // permission (write) on the GitHub App. The app may still need installing on the new repo: check repos() afterwards.
    async createRepo(name, { description = '', isPrivate = true } = {}) {
      const t = await api.token();
      if (!t) throw new Error('Not signed in');
      const r = await gh(t, '/user/repos', { method: 'POST', body: JSON.stringify({ name, description, private: isPrivate, auto_init: true }) });
      if (r.status === 422) throw new Error(`A repo called ${name} already exists, or the name is not allowed.`);
      if (r.status === 403 || r.status === 404) throw new Error('This app is not allowed to create repos. Give the GitHub App the "Repository creation" permission, or create the repo on github.com.');
      if (!r.ok) throw new Error(`GitHub ${r.status}`);
      const j = await r.json();
      return { full: j.full_name, branch: j.default_branch };
    },

    // Creates a private repo for the person from a template repo ("owner/name", marked as a template on GitHub), with all its files.
    // Needs the "Repository creation" permission. Resolves when the new repo has its first commit, which can take a few seconds.
    async createRepoFromTemplate(template, name, { description = '', isPrivate = true } = {}) {
      const t = await api.token();
      if (!t) throw new Error('Not signed in');
      const r = await gh(t, `/repos/${template}/generate`, { method: 'POST', body: JSON.stringify({ name, description, private: isPrivate, include_all_branches: false }) });
      if (r.status === 422) throw new Error(`A repo called ${name} already exists, or the name is not allowed.`);
      if (r.status === 403) throw new Error('This app is not allowed to create repos. Give the GitHub App the "Repository creation" permission.');
      if (r.status === 404) throw new Error(`${template} was not found, or is not a template repo.`);
      if (!r.ok) throw new Error(`GitHub ${r.status}`);
      const j = await r.json();
      for (let i = 0; i < 20; i++) {
        const ref = await gh(t, `/repos/${j.full_name}/git/ref/heads/${encodeURIComponent(j.default_branch)}`);
        if (ref.ok) break;
        await new Promise((res) => setTimeout(res, 500));
      }
      return { full: j.full_name, branch: j.default_branch };
    },

    // { text, sha, etag } or null when the file does not exist. Pass the etag of an earlier read to get
    // { notModified: true, etag } instead when nothing changed; GitHub does not count that against the rate limit.
    async read(repo, path, branch, etag) {
      const t = await api.token();
      const r = await gh(t, `/repos/${repo}/contents/${at(path)}${branch ? `?ref=${encodeURIComponent(branch)}` : ''}`, etag ? { headers: { 'If-None-Match': etag } } : {});
      if (r.status === 304) return { notModified: true, etag };
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`GitHub ${r.status}`);
      const j = await r.json();
      return { text: unb64(j.content), sha: j.sha, etag: r.headers.get('ETag') };
    },

    // Entries of a folder: [{ name, path, type: 'file' | 'dir', sha, size }]. A missing folder is an empty list.
    async list(repo, dir = '', branch) {
      const t = await api.token();
      const r = await gh(t, `/repos/${repo}/contents/${at(dir)}${branch ? `?ref=${encodeURIComponent(branch)}` : ''}`);
      if (r.status === 404) return [];
      if (!r.ok) throw new Error(`GitHub ${r.status}`);
      const j = await r.json();
      return (Array.isArray(j) ? j : []).map((x) => ({ name: x.name, path: x.path, type: x.type === 'dir' ? 'dir' : 'file', sha: x.sha, size: x.size }));
    },

    // Creates or replaces the file. Pass the sha from read() when it exists; a stale one throws Conflict.
    async write(repo, path, text, sha, branch, message = 'Update') {
      const t = await api.token();
      const r = await gh(t, `/repos/${repo}/contents/${at(path)}`, {
        method: 'PUT',
        body: JSON.stringify({ message, content: b64(text), ...(sha ? { sha } : {}), ...(branch ? { branch } : {}) }),
      });
      if (r.status === 409 || r.status === 422) throw new Conflict();
      if (!r.ok) throw new Error(`GitHub ${r.status}`);
      return (await r.json()).content.sha;
    },

    // Several files in ONE commit: files is { path: text, path2: null } (null deletes). Returns { commit } (the new commit sha).
    // With { base } (a commit sha from head() or an earlier writeMany) it only succeeds if the branch is still at base, else Conflict.
    // Without base it commits on top of the branch's current head, so files you list replace what is there, but files you do not list stay as they are.
    async writeMany(repo, files, { branch, message = 'Update', base } = {}) {
      const t = await api.token();
      if (!t) throw new Error('Not signed in');
      const br = branch || (await (await gh(t, `/repos/${repo}`)).json()).default_branch;
      const call = async (path, method = 'GET', body) => {
        const r = await gh(t, `/repos/${repo}${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
        if (!r.ok && !(method === 'PATCH' && (r.status === 409 || r.status === 422))) throw new Error(`GitHub ${r.status}`);
        return r;
      };
      const entries = Object.entries(files).map(([p, text]) => ({ path: at(p), mode: '100644', type: 'blob', ...(text === null ? { sha: null } : { content: text }) }));
      for (let attempt = 0; attempt < 4; attempt++) {
        const head = (await (await call(`/git/ref/heads/${encodeURIComponent(br)}`)).json()).object.sha;
        if (base && base !== head) throw new Conflict();
        const baseTree = (await (await call(`/git/commits/${head}`)).json()).tree.sha;
        const tree = await (await call('/git/trees', 'POST', { base_tree: baseTree, tree: entries })).json();
        const commit = await (await call('/git/commits', 'POST', { message, tree: tree.sha, parents: [head] })).json();
        const up = await call(`/git/refs/heads/${encodeURIComponent(br)}`, 'PATCH', { sha: commit.sha });
        if (up.ok) return { commit: commit.sha };
        if (base) throw new Conflict();
      }
      throw new Conflict();
    },

    // Every file of the app's folder on a branch: { head, files: { path: sha } }, paths relative to the folder. Used by the store in store.js.
    async tree(repo, branch) {
      const t = await api.token();
      const br = branch || (await (await gh(t, `/repos/${repo}`)).json()).default_branch;
      const ref = await gh(t, `/repos/${repo}/git/ref/heads/${encodeURIComponent(br)}`);
      if (ref.status === 404 || ref.status === 409) return { head: null, files: {} };
      if (!ref.ok) throw new Error(`GitHub ${ref.status}`);
      const head = (await ref.json()).object.sha;
      const r = await gh(t, `/repos/${repo}/git/trees/${head}?recursive=1`);
      if (!r.ok) throw new Error(`GitHub ${r.status}`);
      const j = await r.json();
      if (j.truncated) throw new Error('The repo has too many files to list.');
      const prefix = at('');
      const pre = prefix ? `${prefix}/` : '';
      const files = {};
      for (const e of j.tree) if (e.type === 'blob' && e.path.startsWith(pre)) files[e.path.slice(pre.length)] = e.sha;
      return { head, files };
    },

    // The text of a file by its sha, as listed by tree().
    async blob(repo, sha) {
      const t = await api.token();
      const r = await gh(t, `/repos/${repo}/git/blobs/${sha}`);
      if (!r.ok) throw new Error(`GitHub ${r.status}`);
      return unb64((await r.json()).content);
    },

    // The commits that touched a file, newest first: [{ sha, message, author, date }]. Pass a sha to read() to get that version.
    async history(repo, path, { branch, limit = 30 } = {}) {
      const t = await api.token();
      const q = new URLSearchParams({ path: at(path), per_page: String(limit), ...(branch ? { sha: branch } : {}) });
      const r = await gh(t, `/repos/${repo}/commits?${q}`);
      if (r.status === 404 || r.status === 409) return [];
      if (!r.ok) throw new Error(`GitHub ${r.status}`);
      return (await r.json()).map((c) => ({ sha: c.sha, message: c.commit.message.split('\n')[0], author: c.commit.author?.name ?? c.author?.login ?? '', date: c.commit.author?.date ?? '' }));
    },

    // The branch's current commit: { sha, etag }. With the etag of an earlier call: { notModified: true, etag } when nothing changed (free).
    async head(repo, branch, etag) {
      const t = await api.token();
      const br = branch || (await (await gh(t, `/repos/${repo}`)).json()).default_branch;
      const r = await gh(t, `/repos/${repo}/git/ref/heads/${encodeURIComponent(br)}`, etag ? { headers: { 'If-None-Match': etag } } : {});
      if (r.status === 304) return { notModified: true, etag };
      if (!r.ok) throw new Error(`GitHub ${r.status}`);
      return { sha: (await r.json()).object.sha, etag: r.headers.get('ETag') };
    },

    // What changed since a commit: { head, files: [{ path, status }] }, status 'added' | 'modified' | 'removed'. Only files under the client's folder, with paths relative to it.
    // GitHub lists at most 300 files here; truncated is true when there may be more.
    async changes(repo, since, branch) {
      const t = await api.token();
      const br = branch || (await (await gh(t, `/repos/${repo}`)).json()).default_branch;
      const r = await gh(t, `/repos/${repo}/compare/${since}...${encodeURIComponent(br)}`);
      if (r.status === 404) throw new Error('That commit is not on the branch any more. Read everything again.');
      if (!r.ok) throw new Error(`GitHub ${r.status}`);
      const j = await r.json();
      const prefix = at('');
      const pre = prefix ? `${prefix}/` : '';
      const files = (j.files ?? [])
        .filter((f) => f.filename.startsWith(pre))
        .map((f) => ({ path: f.filename.slice(pre.length), status: f.status === 'removed' ? 'removed' : f.status === 'added' ? 'added' : 'modified' }));
      return { head: j.commits?.length ? j.commits[j.commits.length - 1].sha : since, files, truncated: (j.files ?? []).length >= 300 };
    },

    // Deletes the file. Needs the current sha; a stale one throws Conflict. Returns false if it was already gone.
    async remove(repo, path, sha, branch, message = 'Delete') {
      const t = await api.token();
      const r = await gh(t, `/repos/${repo}/contents/${at(path)}`, {
        method: 'DELETE',
        body: JSON.stringify({ message, sha, ...(branch ? { branch } : {}) }),
      });
      if (r.status === 404) return false;
      if (r.status === 409 || r.status === 422) throw new Conflict();
      if (!r.ok) throw new Error(`GitHub ${r.status}`);
      return true;
    },
  };
  return api;
}
