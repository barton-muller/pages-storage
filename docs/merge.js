// Merging for apps that keep their data in a repo that several devices write to.
//
//   merge3Keys(base, local, remote)       flat settings: per key, a change on one side wins over no change on the other
//   mergeRecords(local, remote)           records with an updatedAt: the newest wins, deletes are records with deleted: true
//   syncFiles(store, { files, base, ... }) three-way sync of whole files over any store (see store.js), in one commit, with retry
//
// Nothing here knows about GitHub. A store has three calls: fetch() -> { revision, files: { path: id } }, read(id) -> text,
// commit(expected, changes, message) -> revision, which throws Conflict when the remote is no longer at `expected`.

import { Conflict } from './conflict.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Three-way merge of two flat objects against the object both started from. `base` may be null (first sync).
// A key changed on both sides goes to local, or to remote with { preferRemote: true }. A key only one side has is kept.
export function merge3Keys(base, local, remote, { preferRemote = false } = {}) {
  if (!remote) return { ...local };
  const b = base ?? {};
  const out = {};
  for (const key of [...new Set([...Object.keys(local ?? {}), ...Object.keys(remote)])].sort()) {
    const l = local?.[key];
    const r = remote[key];
    out[key] =
      l === undefined ? r
      : r === undefined || same(l, r) ? l
      : same(l, b[key]) ? r
      : same(r, b[key]) ? l
      : preferRemote ? r : l;
  }
  return out;
}

// Merges two maps of records { id: { updatedAt, deleted?, ... } }. The record with the newest updatedAt wins, a tie goes to local.
// Deleted records stay as tombstones, so a delete on one device is not undone by a device that still has the record.
export function mergeRecords(local, remote) {
  const out = { ...(remote ?? {}) };
  for (const [id, l] of Object.entries(local ?? {})) {
    const r = out[id];
    if (!r || String(l.updatedAt ?? '') >= String(r.updatedAt ?? '')) out[id] = l;
  }
  return out;
}

// What to do with one file when base, local and remote text may differ (undefined = no such file). Returns the text both
// sides should have, or null to delete the file. A change wins over no change, a change wins over a delete, and when both
// sides changed the file local wins.
export function mergeText(path, base, local, remote) {
  if (local === remote) return local ?? null;
  if (local === base) return remote ?? null;
  if (remote === base) return local ?? null;
  return local ?? remote ?? null;
}

// Brings local files and a store to the same state.
//   store      see above
//   files      { path: text } the files this app has locally (only the ones it manages)
//   base       what the last call returned as `base`, or null the first time
//   merge      (path, baseText, localText, remoteText) => text | null, default mergeText. Use merge3Keys or mergeRecords inside for JSON
//   include    (path) => boolean, which remote paths belong to this app. Default: all
//   message    commit message
// Returns { files, base, revision, pulled, pushed }: the merged files to keep locally, the base to hand to the next call,
// the paths that changed locally and the paths that were written to the store.
export async function syncFiles(store, { files, base = null, merge = mergeText, include = () => true, message = 'Sync', attempts = 3 }) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const snap = await store.fetch();
    const known = base?.files ?? {};
    const ids = base?.ids ?? {};
    const remote = {};
    for (const [path, id] of Object.entries(snap.files)) {
      if (!include(path)) continue;
      remote[path] = id === ids[path] && known[path] !== undefined ? known[path] : await store.read(id);
    }
    const merged = {};
    const pulled = [];
    const changes = {};
    for (const path of new Set([...Object.keys(files), ...Object.keys(remote), ...Object.keys(known)])) {
      const text = merge(path, known[path], files[path], remote[path]);
      if (text !== null && text !== undefined) merged[path] = text;
      if ((text ?? undefined) !== files[path]) pulled.push(path);
      if ((text ?? undefined) !== remote[path]) changes[path] = text ?? null;
    }
    try {
      const revision = Object.keys(changes).length ? await store.commit(snap.revision, changes, message) : snap.revision;
      // the ids of the files that did not change; the written ones are read again next time
      const newIds = {};
      for (const [path, id] of Object.entries(snap.files)) if (include(path) && !(path in changes)) newIds[path] = id;
      // the base is a copy, so editing the returned files does not change it
      return { files: merged, base: { files: { ...merged }, ids: newIds, revision }, revision, pulled, pushed: Object.keys(changes) };
    } catch (e) {
      if (!(e instanceof Conflict) || attempt === attempts - 1) throw e;
      // the remote moved on since we fetched it: fetch and merge again
    }
  }
}
