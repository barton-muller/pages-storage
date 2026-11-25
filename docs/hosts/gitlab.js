// GitLab (gitlab.com and self-managed), through the REST API v4 with a token.
// The project is addressed by its full path, URL-encoded (group/subgroup/project). A commit is one call to POST /repository/commits
// with create, update and delete actions. GitLab refuses an action that does not fit the state of the files (create of a file that
// exists, update or delete of one that does not, or of one that changed since last_commit_id) with 400 and a message; that is how a
// change made in the meantime shows up, and it is reported as the Conflict.
// Lists are paged: the header X-Next-Page, which GitLab exposes to web pages, holds the next page number.

import { Conflict, HostError } from './errors.js';
import { createHttp, need } from './http.js';
import { resolveToken, unb64 } from './shared.js';

const MAX_PAGES = 500;
const DEVELOPER = 30; // access level that may push

export const gitlab = {
  id: 'gitlab',
  label: 'GitLab',
  concurrency: 'files',
  known: ['gitlab.com'],
  // groups can nest, so a project path has two or more parts
  repoPath: (segments) => (segments.length >= 2 ? segments.join('/') : null),

  create({ origin, repo, token, fetch }) {
    const http = createHttp({
      host: 'gitlab', label: 'GitLab', base: `${origin}/api/v4/projects/${encodeURIComponent(repo)}`, fetch,
      headers: async () => {
        const t = await resolveToken(token);
        return t ? { Authorization: `Bearer ${t}` } : {};
      },
    });
    const head = async (branch) => {
      const r = await http.get(`/repository/branches/${encodeURIComponent(branch)}`, { allow: [404] });
      return r.ok ? need(r, 'commit.id').body.commit.id : null;
    };
    const stateMismatch = /already exists|doesn't exist|does not exist|has changed|changed since|has not changed|nothing to commit/i;
    return {
      async repoInfo() {
        const r = need(await http.get(''), 'default_branch');
        const levels = [r.body.permissions?.project_access?.access_level, r.body.permissions?.group_access?.access_level].filter((n) => typeof n === 'number');
        return { defaultBranch: r.body.default_branch, canWrite: levels.length ? Math.max(...levels) >= DEVELOPER : undefined };
      },
      branchHead: head,
      async listFiles(commit) {
        const files = {};
        let page = '1';
        for (let i = 0; i < MAX_PAGES && page; i++) {
          const r = need(await http.get('/repository/tree', { query: { ref: commit, recursive: 'true', per_page: '100', page } }), '[]');
          for (const e of r.body) if (e.type === 'blob') files[e.path] = e.id;
          page = r.headers.get('x-next-page') || '';
        }
        return files;
      },
      async readBlob(id) {
        return unb64(need(await http.get(`/repository/blobs/${id}`), 'content').body.content);
      },
      async commit(branch, parent, list, message) {
        // GitLab does not compare the branch head. For a file we update or delete it compares last_commit_id, the last commit that
        // touched the file, so we read that first. A file that changed in between makes GitLab refuse, which is the Conflict.
        const lastCommit = async (path) => need(await http.get(`/repository/files/${encodeURIComponent(path)}`, { query: { ref: parent } }), 'last_commit_id').body.last_commit_id;
        const actions = [];
        for (const e of list) {
          actions.push({
            action: e.op, file_path: e.path,
            ...(e.op === 'delete' ? {} : { content: e.text, encoding: 'text' }),
            ...(e.op === 'create' ? {} : { last_commit_id: await lastCommit(e.path) }),
          });
        }
        const r = await http.post('/repository/commits', { branch, commit_message: message, actions }, { allow: [400] });
        if (!r.ok) {
          const why = r.body?.message ?? r.text;
          if (stateMismatch.test(String(typeof why === 'string' ? why : JSON.stringify(why)))) throw new Conflict();
          throw new HostError(`GitLab 400 for ${r.call}: ${typeof why === 'string' ? why : JSON.stringify(why)}`, { host: 'gitlab', call: r.call, status: 400 });
        }
        return need(r, 'id').body.id;
      },
      async createBranch(name, from) {
        const r = await http.post('/repository/branches', { branch: name, ref: from }, { allow: [400] });
        if (!r.ok && !/already exists/i.test(String(r.body?.message ?? r.text))) {
          throw new HostError(`GitLab 400 for ${r.call}: ${r.body?.message ?? r.text}`, { host: 'gitlab', call: r.call, status: 400 });
        }
        return r.ok;
      },
    };
  },

  // GitLab answers /api/v4/version with { version } when signed in and with a JSON 401 { message } otherwise.
  async probe(origin, fetch) {
    try {
      const r = await fetch(`${origin}/api/v4/version`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (![200, 401, 403].includes(r.status)) return false;
      const j = await r.json();
      return !!(j && typeof j === 'object' && (j.version || (r.status !== 200 && typeof j.message === 'string')));
    } catch { return false; }
  },
};

