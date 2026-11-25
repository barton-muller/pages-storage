// The store every host shares. An adapter (github.js, gitlab.js, forgejo.js) only translates this small set of calls to its host's API:
//
//   ops.repoInfo()                            -> { defaultBranch, canWrite }   canWrite is undefined when the host does not say
//   ops.branchHead(branch)                    -> commit id, or null when the branch does not exist
//   ops.listFiles(head)                       -> { path: contentId } of every file at that commit (all pages, files only)
//   ops.readBlob(id)                          -> the text of a file
//   ops.commit(branch, head, list, message)   -> new commit id. list is [{ op: 'create' | 'update' | 'delete', path, text, id }],
//                                                id being the current content id of an updated or deleted file.
//                                                One commit for all of it. Throws Conflict when the host says the files or
//                                                the branch are not as the commit assumed
//   ops.createBranch(name, from)              -> true when created, false when it existed
//
// Everything that must behave the same on every host is here and nowhere else: the head check, create versus update, deletes of
// files that are not there, folders, empty repos, a missing repo versus a missing branch, and branches.

import { Conflict, Unsupported } from './errors.js';

export function createGitStore({ host, label, ops, branch, folder = '', concurrency }) {
  const trimmed = folder.replace(/^\/+|\/+$/g, '');
  const prefix = trimmed ? `${trimmed}/` : '';
  let last = { revision: null, files: {} }; // every file of the last fetch, with full paths

  const inFolder = (files) => Object.fromEntries(Object.entries(files).filter(([p]) => p.startsWith(prefix)).map(([p, id]) => [p.slice(prefix.length), id]));
  const emptyRepo = () => new Unsupported(`${label} cannot take the first commit of an empty repo through its API. Add a first commit (a README) on ${label}, then connect.`, { host });

  const store = {
    host,
    label,
    // What this host can do. The conformance suite checks that these are true.
    //   createOnEmpty  can take the first commit of an empty repo (no host does, see emptyRepo)
    //   concurrency    what makes a commit fail when someone else committed between our head check and the host call:
    //                  'branch' the host refuses a commit that is not on top of the branch (git's fast-forward rule)
    //                  'files'  the host refuses a change to a file that changed since we read it (a commit that touches other files goes through)
    capabilities: { createOnEmpty: false, concurrency },

    repoInfo: () => ops.repoInfo(),

    async fetch() {
      const head = await ops.branchHead(branch);
      if (head === null) {
        // No such branch. If the repo itself is missing, say so, instead of calling it empty.
        await ops.repoInfo();
        last = { revision: null, files: {} };
        return { revision: null, files: {} };
      }
      last = { revision: head, files: await ops.listFiles(head) };
      return { revision: head, files: inFolder(last.files) };
    },

    read: (id) => ops.readBlob(id),

    async commit(expected, changes, message = 'Sync') {
      if (expected === null || expected === undefined) throw emptyRepo();
      if ((await ops.branchHead(branch)) !== expected) throw new Conflict();
      if (last.revision !== expected) {
        await store.fetch();
        if (last.revision !== expected) throw new Conflict();
      }
      const list = [];
      for (const [path, text] of Object.entries(changes)) {
        const full = prefix + path;
        const exists = last.files[full] !== undefined;
        const id = last.files[full]; // the content id the host has now, which update and delete name
        if (text === null) { if (exists) list.push({ op: 'delete', path: full, id }); } // deleting what is not there is nothing to do
        else list.push({ op: exists ? 'update' : 'create', path: full, text, id });
      }
      if (!list.length) return expected;
      return ops.commit(branch, expected, list, message);
    },

    // Makes sure the branch exists, starting it from the default branch. Returns true when it had to create it.
    async ensureBranch() {
      const info = await ops.repoInfo();
      if (branch === info.defaultBranch) return false;
      if ((await ops.branchHead(branch)) !== null) return false;
      if ((await ops.branchHead(info.defaultBranch)) === null) throw emptyRepo();
      return ops.createBranch(branch, info.defaultBranch);
    },
  };
  return store;
}

