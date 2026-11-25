// Forgejo and Gitea's API v1 (repos/:owner/:name), as far as the adapter uses it. Pages the tree like the real thing does:
// per_page and page, with truncated and total_count in the answer.

import { createFakeServer } from '../server.js';

export function fakeForgejo(repo = 'me/data', origin = 'https://git.example.org') {
  return createFakeServer({
    id: 'forgejo', origin, repo, apiPrefix: `/api/v1/repos/${repo}`,
    routes: ['repo', 'branch', 'tree', 'blob', 'contents', 'newBranch'],
    unread: ['newBranch'],
    probe: ({ method, path }) => (method === 'GET' && path === '/api/v1/version' ? { status: 200, body: { version: '11.0.0+gitea-1.22.0' } } : null),
    handle({ method, path, query, body, server }) {
      const m = server.model;
      const err = (route, status, message) => ({ route, status, body: { message, url: 'https://x/api/swagger' } });
      if (server.repoMissing) return err('repo', 404, 'The target couldn\'t be found.');
      let x;
      if (method === 'GET' && path === '') return { route: 'repo', status: 200, body: { default_branch: 'main', permissions: { admin: false, push: server.canWrite, pull: true }, empty: m.branches.size === 0 } };
      if (method === 'GET' && (x = path.match(/^\/branches\/(.+)$/))) {
        const head = m.head(decodeURIComponent(x[1]));
        return head ? { route: 'branch', status: 200, body: { name: decodeURIComponent(x[1]), commit: { id: head, message: 'x' } } } : err('branch', 404, 'branch does not exist');
      }
      if (method === 'GET' && (x = path.match(/^\/git\/trees\/([0-9a-f]+)$/))) {
        if (!m.commits.has(x[1])) return err('tree', 404, 'not found');
        const all = [...m.commits.get(x[1]).files];
        // Gitea clamps the page size to MAX_RESPONSE_ITEMS, 50 by default, whatever per_page asks for
        const per = Math.min(Number(query.get('per_page') ?? 30), 50);
        const page = Math.max(Number(query.get('page') ?? 1), 1);
        const slice = all.slice((page - 1) * per, page * per);
        return { route: 'tree', status: 200, body: {
          sha: x[1], page, total_count: all.length, truncated: page * per < all.length,
          tree: slice.map(([path, sha]) => ({ path, mode: '100644', type: 'blob', size: m.blobs.get(sha).length, sha })),
        } };
      }
      if (method === 'GET' && (x = path.match(/^\/git\/blobs\/([0-9a-f]+)$/))) {
        const text = m.blobs.get(x[1]);
        return text === undefined ? err('blob', 404, 'not found') : { route: 'blob', status: 200, body: { sha: x[1], encoding: 'base64', size: text.length, content: Buffer.from(text).toString('base64') } };
      }
      if (method === 'POST' && path === '/contents') {
        const branch = body?.branch;
        const head = m.head(branch);
        if (!head || !Array.isArray(body.files) || !body.message) return err('contents', 422, 'invalid');
        const files = m.commits.get(head).files;
        const changes = {};
        for (const f of body.files) {
          const current = files.get(f.path);
          if (f.operation === 'create') {
            if (current !== undefined) return err('contents', 422, 'repository file already exists');
            changes[f.path] = Buffer.from(f.content ?? '', 'base64').toString();
          } else if (f.operation === 'update') {
            if (current === undefined) return err('contents', 404, 'file does not exist');
            if (f.sha !== current) return err('contents', 409, 'sha does not match');
            changes[f.path] = Buffer.from(f.content ?? '', 'base64').toString();
          } else if (f.operation === 'delete') {
            if (current === undefined) return err('contents', 404, 'file does not exist');
            if (f.sha !== current) return err('contents', 409, 'sha does not match');
            changes[f.path] = null;
          } else return err('contents', 422, 'unknown operation');
        }
        const id = m.commit(changes, { branch, message: body.message });
        return { route: 'contents', status: 201, body: { commit: { sha: id }, files: [] } };
      }
      if (method === 'POST' && path === '/branches') {
        if (m.head(body?.new_branch_name)) return err('newBranch', 409, 'branch already exists');
        if (!m.head(body?.old_branch_name)) return err('newBranch', 404, 'old branch does not exist');
        m.createBranch(body.new_branch_name, body.old_branch_name);
        return { route: 'newBranch', status: 201, body: { name: body.new_branch_name, commit: { id: m.head(body.new_branch_name) } } };
      }
      return err('unknown', 404, `no route ${method} ${path}`);
    },
  });
}
