// GitHub, through the REST API with a token (a personal access token or the token of a sign-in).
// Commits are built with the Git data API: one tree and one commit for all files, then the branch is moved without force,
// which is refused when the branch moved on. That refusal is the Conflict.

import { Conflict, HostError } from './errors.js';
import { createHttp, need } from './http.js';
import { encPath, resolveToken, unb64 } from './shared.js';

export const github = {
  id: 'github',
  label: 'GitHub',
  concurrency: 'branch',
  known: ['github.com', 'www.github.com'],
  // GitHub repos are owner/name
  repoPath: (segments) => (segments.length === 2 ? segments.join('/') : null),

  create({ repo, token, fetch, apiBase = 'https://api.github.com' }) {
    const http = createHttp({
      host: 'github', label: 'GitHub', base: `${apiBase}/repos/${repo}`, fetch,
      headers: async () => {
        const t = await resolveToken(token);
        return { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(t ? { Authorization: `Bearer ${t}` } : {}) };
      },
    });
    const head = async (branch) => {
      const r = await http.get(`/git/ref/heads/${encPath(branch)}`, { allow: [404, 409] }); // 409: the repo has no commits
      if (!r.ok) return null;
      return need(r, 'object.sha').body.object.sha;
    };
    return {
      async repoInfo() {
        const r = need(await http.get(''), 'default_branch');
        return { defaultBranch: r.body.default_branch, canWrite: r.body.permissions?.push };
      },
      branchHead: head,
      async listFiles(commit) {
        const c = need(await http.get(`/git/commits/${commit}`), 'tree.sha');
        const t = need(await http.get(`/git/trees/${c.body.tree.sha}`, { query: { recursive: '1' } }), 'tree');
        if (t.body.truncated) throw new HostError('This repo has too many files for GitHub to list in one answer.', { host: 'github', call: t.call });
        const files = {};
        for (const e of t.body.tree) if (e.type === 'blob') files[e.path] = e.sha;
        return files;
      },
      async readBlob(id) {
        return unb64(need(await http.get(`/git/blobs/${id}`), 'content').body.content);
      },
      async commit(branch, parent, list, message) {
        const entries = list.map((e) => ({ path: e.path, mode: '100644', type: 'blob', ...(e.op === 'delete' ? { sha: null } : { content: e.text }) }));
        const base = need(await http.get(`/git/commits/${parent}`), 'tree.sha').body.tree.sha;
        const tree = need(await http.post('/git/trees', { base_tree: base, tree: entries }), 'sha').body.sha;
        const commit = need(await http.post('/git/commits', { message, tree, parents: [parent] }), 'sha').body.sha;
        const moved = await http.patch(`/git/refs/heads/${encPath(branch)}`, { sha: commit, force: false }, { allow: [409, 422] });
        if (!moved.ok) throw new Conflict(); // not a fast-forward: the branch moved on
        return commit;
      },
      async createBranch(name, from) {
        const sha = await head(from);
        const r = await http.post('/git/refs', { ref: `refs/heads/${name}`, sha }, { allow: [422] }); // 422: it exists
        return r.ok;
      },
    };
  },

  // No probe: GitHub is only github.com. GitHub Enterprise Server is not supported yet.
};

