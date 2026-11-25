// GitLab's REST API v4 (projects/:id/repository/*), as far as the adapter uses it. The project id is the URL-encoded path.
// Lists are paged with the X-Next-Page header. Commit actions must fit the state of the files, as on the real thing.

import { createFakeServer } from '../server.js';

// The last commit, walking back from `commit`, that changed the file
function lastCommitOf(m, commit, file) {
  for (let c = commit; c; c = m.commits.get(c).parent) {
    const parent = m.commits.get(c).parent;
    if (m.commits.get(c).files.get(file) !== (parent ? m.commits.get(parent).files.get(file) : undefined)) return c;
  }
  return null;
}

export function fakeGitLab(repo = 'me/data', origin = 'https://git.example.org') {
  return createFakeServer({
    id: 'gitlab', origin, repo, apiPrefix: `/api/v4/projects/${encodeURIComponent(repo)}`,
    routes: ['project', 'branch', 'tree', 'blob', 'file', 'commits', 'newBranch'],
    unread: ['newBranch'],
    probe: ({ method, path, token }) => (method === 'GET' && path === '/api/v4/version'
      ? (token ? { status: 200, body: { version: '17.0.0', revision: 'x' } } : { status: 401, body: { message: '401 Unauthorized' } })
      : method === 'GET' && path === '/api/v1/version' ? { status: 404, body: { error: '404 Not Found' } } : null),
    handle({ method, path, query, body, server }) {
      const m = server.model;
      const err = (route, status, message) => ({ route, status, body: { message } });
      if (server.repoMissing) return err('project', 404, '404 Project Not Found');
      let x;
      if (method === 'GET' && path === '') return { route: 'project', status: 200, body: { id: 1, default_branch: 'main', path_with_namespace: repo, permissions: { project_access: { access_level: server.canWrite ? 40 : 20 }, group_access: null } } };
      if (method === 'GET' && (x = path.match(/^\/repository\/branches\/(.+)$/))) {
        const head = m.head(decodeURIComponent(x[1]));
        return head ? { route: 'branch', status: 200, body: { name: decodeURIComponent(x[1]), commit: { id: head }, default: x[1] === 'main' } } : err('branch', 404, '404 Branch Not Found');
      }
      if (method === 'GET' && path === '/repository/tree') {
        const commit = query.get('ref');
        if (!m.commits.has(commit)) return err('tree', 404, '404 Tree Not Found');
        const all = [...m.commits.get(commit).files];
        const per = Math.min(Number(query.get('per_page') ?? 20), 100);
        const page = Math.max(Number(query.get('page') ?? 1), 1);
        const slice = all.slice((page - 1) * per, page * per);
        return { route: 'tree', status: 200,
          body: slice.map(([path, id]) => ({ id, name: path.split('/').pop(), type: 'blob', path, mode: '100644' })),
          headers: { 'x-next-page': page * per < all.length ? String(page + 1) : '', 'x-page': String(page) } };
      }
      if (method === 'GET' && (x = path.match(/^\/repository\/blobs\/([0-9a-f]+)$/))) {
        const text = m.blobs.get(x[1]);
        return text === undefined ? err('blob', 404, '404 Blob Not Found') : { route: 'blob', status: 200, body: { size: text.length, encoding: 'base64', content: Buffer.from(text).toString('base64'), sha: x[1] } };
      }
      if (method === 'GET' && (x = path.match(/^\/repository\/files\/(.+)$/))) {
        const file = decodeURIComponent(x[1]);
        const commit = query.get('ref');
        const id = m.commits.get(commit)?.files.get(file);
        if (!id) return err('file', 404, '404 File Not Found');
        return { route: 'file', status: 200, body: { file_name: file.split('/').pop(), file_path: file, size: 0, encoding: 'base64', content: '', blob_id: id, commit_id: commit, last_commit_id: lastCommitOf(m, commit, file), ref: commit } };
      }
      if (method === 'POST' && path === '/repository/commits') {
        const branch = body?.branch;
        if (!body?.commit_message || !Array.isArray(body.actions) || !branch) return err('commits', 400, 'branch, commit_message and actions are required');
        const head = m.head(branch);
        if (!head) return err('commits', 400, 'You can only create or edit files when you are on a branch');
        const files = m.commits.get(head).files;
        const changes = {};
        for (const a of body.actions) {
          const exists = files.has(a.file_path) || a.file_path in changes && changes[a.file_path] !== null;
          if (a.action === 'create') {
            if (exists) return err('commits', 400, `A file with this name already exists`);
            if (typeof a.content !== 'string') return err('commits', 400, 'actions[][content] is missing');
            changes[a.file_path] = a.content;
          } else if (a.action === 'update') {
            if (!exists) return err('commits', 400, `A file with this name doesn't exist`);
            if (a.last_commit_id && a.last_commit_id !== lastCommitOf(m, head, a.file_path)) return err('commits', 400, 'You are attempting to update a file that has changed since you started editing it.');
            if (typeof a.content !== 'string') return err('commits', 400, 'actions[][content] is missing');
            changes[a.file_path] = a.content;
          } else if (a.action === 'delete') {
            if (!exists) return err('commits', 400, `A file with this name doesn't exist`);
            if (a.last_commit_id && a.last_commit_id !== lastCommitOf(m, head, a.file_path)) return err('commits', 400, 'You are attempting to delete a file that has changed since you started editing it.');
            changes[a.file_path] = null;
          } else return err('commits', 400, 'actions[][action] does not have a valid value');
        }
        const id = m.commit(changes, { branch, message: body.commit_message });
        return { route: 'commits', status: 201, body: { id, short_id: id.slice(0, 8), message: body.commit_message } };
      }
      if (method === 'POST' && path === '/repository/branches') {
        if (m.head(body?.branch)) return err('newBranch', 400, 'Branch already exists');
        if (!m.head(body?.ref)) return err('newBranch', 400, 'Invalid reference name');
        m.createBranch(body.branch, body.ref);
        return { route: 'newBranch', status: 201, body: { name: body.branch, commit: { id: m.head(body.branch) } } };
      }
      return err('unknown', 404, `404 Not Found: ${method} ${path}`);
    },
  });
}
