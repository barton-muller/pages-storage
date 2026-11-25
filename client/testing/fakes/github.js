// GitHub's REST API (repos/:repo/git/*), as far as the adapter uses it, and as strict as GitHub is about what it needs.

import { blobId } from '../model.js';
import { createFakeServer } from '../server.js';

const wrap = (text) => Buffer.from(text).toString('base64').replace(/(.{60})/g, '$1\n'); // GitHub wraps base64 lines

export function fakeGitHub(repo = 'me/data') {
  const origin = 'https://api.github.com';
  const trees = new Map(); // tree id -> Map(path -> blobId)
  let n = 0;
  const treeOf = (commit) => `tree-${commit}`;

  return createFakeServer({
    id: 'github', origin, repo, apiPrefix: `/repos/${repo}`,
    routes: ['repo', 'ref', 'commit', 'tree', 'blob', 'newTree', 'newCommit', 'moveRef', 'newRef'],
    unread: ['moveRef', 'newRef'],
    handle({ method, path, query, body, server }) {
      const m = server.model;
      const notFound = (route) => ({ route, status: 404, body: { message: 'Not Found' } });
      if (server.repoMissing) return notFound('repo');
      let x;
      if (method === 'GET' && path === '') return { route: 'repo', status: 200, body: { default_branch: 'main', permissions: { push: server.canWrite, pull: true } } };
      if (method === 'GET' && (x = path.match(/^\/git\/ref\/heads\/(.+)$/))) {
        const head = m.head(decodeURIComponent(x[1]));
        if (!head && m.branches.size === 0) return { route: 'ref', status: 409, body: { message: 'Git Repository is empty.' } };
        return head ? { route: 'ref', status: 200, body: { ref: `refs/heads/${x[1]}`, object: { sha: head, type: 'commit' } } } : notFound('ref');
      }
      if (method === 'GET' && (x = path.match(/^\/git\/commits\/([0-9a-f]+)$/))) {
        return m.commits.has(x[1]) ? { route: 'commit', status: 200, body: { sha: x[1], tree: { sha: treeOf(x[1]) } } } : notFound('commit');
      }
      if (method === 'GET' && (x = path.match(/^\/git\/trees\/(tree-[0-9a-f]+)$/))) {
        const files = trees.get(x[1]) ?? m.commits.get(x[1].slice(5))?.files;
        if (!files) return notFound('tree');
        if (query.get('recursive') !== '1') return { route: 'tree', status: 200, body: { sha: x[1], tree: [], truncated: false } };
        return { route: 'tree', status: 200, body: { sha: x[1], truncated: false, tree: [...files].map(([path, sha]) => ({ path, mode: '100644', type: 'blob', sha, size: m.blobs.get(sha).length })) } };
      }
      if (method === 'GET' && (x = path.match(/^\/git\/blobs\/([0-9a-f]+)$/))) {
        const text = m.blobs.get(x[1]);
        return text === undefined ? notFound('blob') : { route: 'blob', status: 200, body: { sha: x[1], encoding: 'base64', size: text.length, content: wrap(text) } };
      }
      if (method === 'POST' && path === '/git/trees') {
        const base = trees.get(body?.base_tree) ?? m.commits.get(String(body?.base_tree).slice(5))?.files;
        if (!base || !Array.isArray(body.tree)) return { route: 'newTree', status: 422, body: { message: 'Invalid tree info' } };
        const files = new Map(base);
        for (const e of body.tree) {
          if (e.mode !== '100644' || e.type !== 'blob' || !('sha' in e || 'content' in e)) return { route: 'newTree', status: 422, body: { message: 'Invalid tree info' } };
          if (e.sha === null) files.delete(e.path);
          else files.set(e.path, 'content' in e ? m.putBlob(e.content) : e.sha);
        }
        const id = `tree-new${++n}`;
        trees.set(id, files);
        return { route: 'newTree', status: 201, body: { sha: id, tree: [] } };
      }
      if (method === 'POST' && path === '/git/commits') {
        const files = trees.get(body?.tree);
        if (!files || !body.message || !Array.isArray(body.parents)) return { route: 'newCommit', status: 422, body: { message: 'Invalid commit' } };
        return { route: 'newCommit', status: 201, body: { sha: m.detached(body.parents[0], files, body.message) } };
      }
      if (method === 'PATCH' && (x = path.match(/^\/git\/refs\/heads\/(.+)$/))) {
        const branch = decodeURIComponent(x[1]);
        if (!m.head(branch)) return notFound('moveRef');
        const c = m.commits.get(body?.sha);
        if (!c) return { route: 'moveRef', status: 422, body: { message: 'Object does not exist' } };
        if (body.force !== true && c.parent !== m.head(branch)) return { route: 'moveRef', status: 422, body: { message: 'Update is not a fast forward' } };
        m.moveBranch(branch, body.sha);
        return { route: 'moveRef', status: 200, body: { ref: `refs/heads/${branch}`, object: { sha: body.sha } } };
      }
      if (method === 'POST' && path === '/git/refs') {
        const name = String(body?.ref).replace(/^refs\/heads\//, '');
        if (m.head(name)) return { route: 'newRef', status: 422, body: { message: 'Reference already exists' } };
        if (!m.commits.has(body?.sha)) return { route: 'newRef', status: 422, body: { message: 'Object does not exist' } };
        m.moveBranch(name, body.sha);
        return { route: 'newRef', status: 201, body: { ref: body.ref, object: { sha: body.sha } } };
      }
      return { route: 'unknown', status: 404, body: { message: `Not Found: ${method} ${path}` } };
    },
  });
}
export { blobId };
