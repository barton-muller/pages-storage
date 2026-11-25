// Forgejo, Gitea and Codeberg, through the Gitea-compatible REST API (v1) with a token.
// A commit is one call to the batch endpoint POST /contents with create, update and delete operations. Updates and deletes
// carry the sha of the file they expect, so a file that changed makes the host refuse with 409 or 422: that is the Conflict.
// Needs Forgejo, or Gitea 1.20 or newer.

import { Conflict } from './errors.js';
import { createHttp, need } from './http.js';
import { b64, encPath, resolveToken, unb64 } from './shared.js';

const MAX_PAGES = 100;

export const forgejo = {
  id: 'forgejo',
  label: 'Forgejo or Gitea',
  concurrency: 'files',
  known: ['codeberg.org', 'gitea.com'],
  repoPath: (segments) => (segments.length === 2 ? segments.join('/') : null),

  create({ origin, repo, token, fetch }) {
    const http = createHttp({
      host: 'forgejo', label: 'Forgejo or Gitea', base: `${origin}/api/v1/repos/${repo}`, fetch,
      headers: async () => {
        const t = await resolveToken(token);
        return t ? { Authorization: `token ${t}` } : {};
      },
    });
    const head = async (branch) => {
      const r = await http.get(`/branches/${encPath(branch)}`, { allow: [404] });
      return r.ok ? need(r, 'commit.id').body.commit.id : null;
    };
    return {
      async repoInfo() {
        const r = need(await http.get(''), 'default_branch');
        return { defaultBranch: r.body.default_branch, canWrite: r.body.permissions?.push };
      },
      branchHead: head,
      async listFiles(commit) {
        const files = {};
        for (let page = 1; page <= MAX_PAGES; page++) {
          const r = need(await http.get(`/git/trees/${commit}`, { query: { recursive: 'true', per_page: '1000', page: String(page) } }), 'tree');
          for (const e of r.body.tree) if (e.type === 'blob') files[e.path] = e.sha;
          if (!r.body.truncated || r.body.tree.length === 0) break; // truncated means: more pages follow
        }
        return files;
      },
      async readBlob(id) {
        return unb64(need(await http.get(`/git/blobs/${id}`), 'content').body.content);
      },
      async commit(branch, parent, list, message) {
        const files = list.map((e) => ({
          operation: e.op, path: e.path,
          ...(e.op === 'delete' ? {} : { content: b64(e.text) }),
          ...(e.op === 'create' ? {} : { sha: e.id }),
        }));
        const r = await http.post('/contents', { branch, message, files }, { allow: [409, 422] });
        if (!r.ok) throw new Conflict();
        return need(r, 'commit.sha').body.commit.sha;
      },
      async createBranch(name, from) {
        const r = await http.post('/branches', { new_branch_name: name, old_branch_name: from }, { allow: [409] }); // 409: it exists
        return r.ok;
      },
    };
  },

  // Forgejo and Gitea answer /api/v1/version with { version } to everyone.
  async probe(origin, fetch) {
    try {
      const r = await fetch(`${origin}/api/v1/version`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
      const j = r.ok ? await r.json() : null;
      return !!(j && typeof j === 'object' && j.version);
    } catch { return false; }
  },
};
