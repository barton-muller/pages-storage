// A tiny git in memory: branches point to commits, a commit holds the full file list. The fake servers show it through each
// host's API, so the same facts (who changed what, which commit is the head) are what every adapter is tested against.
// Node only: it uses node:crypto for real git blob ids.

import { createHash } from 'node:crypto';

export const blobId = (text) => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');

export function createModel(defaultBranch = 'main') {
  const blobs = new Map(); // id -> text
  const commits = new Map(); // id -> { parent, files: Map(path -> blobId), message }
  const branches = new Map(); // name -> commit id
  let counter = 0;

  const newCommit = (parent, files, message) => {
    const id = createHash('sha1').update(`commit ${++counter}`).digest('hex');
    commits.set(id, { parent, files, message });
    return id;
  };
  const putBlob = (text) => { const id = blobId(text); blobs.set(id, text); return id; };

  const model = {
    defaultBranch,
    blobs, commits, branches,
    head: (branch = defaultBranch) => branches.get(branch) ?? null,
    filesAt: (commit) => commits.get(commit).files,
    // A commit on a branch (created if needed). changes: { path: text | null }
    commit(changes, { branch = defaultBranch, message = 'commit' } = {}) {
      const parent = branches.get(branch) ?? null;
      const files = new Map(parent ? commits.get(parent).files : []);
      for (const [path, text] of Object.entries(changes)) {
        if (text === null) files.delete(path);
        else files.set(path, putBlob(text));
      }
      const id = newCommit(parent, files, message);
      branches.set(branch, id);
      return id;
    },
    // A commit that is not on any branch yet (git data API): the files are the given ones.
    detached(parent, files, message) { return newCommit(parent, files, message); },
    moveBranch(branch, commit) { branches.set(branch, commit); },
    createBranch(name, from) { branches.set(name, branches.get(from)); },
    putBlob,
    // The text of every file on a branch
    texts(branch = defaultBranch) {
      const head = branches.get(branch);
      if (!head) return {};
      return Object.fromEntries([...commits.get(head).files].map(([p, id]) => [p, blobs.get(id)]));
    },
    // Number of commits reachable from the branch
    depth(branch = defaultBranch) {
      let n = 0;
      for (let c = branches.get(branch); c; c = commits.get(c).parent) n++;
      return n;
    },
  };
  return model;
}
