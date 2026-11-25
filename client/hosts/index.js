// The hosts, and how an address becomes a store.
//
//   storeFromUrl('https://gitlab.com/group/sub/project.git', { token })   -> a store, with the default branch looked up
//   parseRepoUrl(url)                                                     -> { host, origin, segments, token } or null
//   detectHost(parsed, fetch)                                             -> the adapter for that address
//   hosts                                                                 -> the registry, adapter id -> adapter
//
// To add a host: write client/hosts/<name>.js with the same shape as gitlab.js, add it to `hosts` below, and write its fake
// server in client/testing/fakes/<name>.js. A test fails until all three exist and the conformance suite passes. See docs/HOSTS.md.

import { HostUnreachable, Unsupported } from './errors.js';
import { forgejo } from './forgejo.js';
import { github } from './github.js';
import { gitlab } from './gitlab.js';
import { createGitStore } from './store.js';

// Order matters for hosts we have to probe: GitLab first, because its /api/v4/version answer is the more specific.
export const hosts = { github, gitlab, forgejo };

// The address of a repo as people copy it for git clone: https://host/group/name(.git), optionally with a token in front
// (https://token@host/group/name.git).
export function parseRepoUrl(input) {
  let u;
  try { u = new URL(String(input).trim()); } catch { return null; }
  const segments = u.pathname.replace(/\/+$/, '').replace(/\.git$/, '').split('/').filter(Boolean);
  if (u.protocol !== 'https:' || segments.length < 2) return null;
  return { host: u.hostname, origin: u.origin, segments, token: decodeURIComponent(u.password || u.username) || undefined };
}

export async function detectHost(parsed, fetch = (...a) => globalThis.fetch(...a)) {
  for (const adapter of Object.values(hosts)) if (adapter.known.includes(parsed.host)) return adapter;
  let answered = false;
  for (const adapter of Object.values(hosts)) {
    if (!adapter.probe) continue; // a host with fixed names, nothing to ask
    try {
      if (await adapter.probe(parsed.origin, fetch)) return adapter;
      answered = true; // it answered, just not like this kind of host
    } catch { /* no answer to this probe */ }
  }
  if (!answered) {
    throw new HostUnreachable(
      `Could not reach ${parsed.host}. Check the address and the connection, and that the server allows web pages to call its API (CORS).`,
      { host: parsed.host },
    );
  }
  throw new Unsupported(
    `Could not tell what kind of git host ${parsed.host} is. Supported: ${Object.values(hosts).map((h) => h.label).join(', ')}. ` +
    'If it is one of those, check the address, and that the server allows web pages to call its API (CORS).',
    { host: parsed.host },
  );
}

// A store for one host, branch and folder. `adapter` is an id of `hosts`.
export function createStore(adapterId, { repo, origin, token, branch, folder = '', fetch = (...a) => globalThis.fetch(...a) }) {
  const adapter = hosts[adapterId];
  if (!adapter) throw new Unsupported(`No adapter for "${adapterId}". Known: ${Object.keys(hosts).join(', ')}.`);
  const ops = adapter.create({ repo, origin, token, fetch });
  return createGitStore({ host: adapter.id, label: adapter.label, ops, branch, folder, concurrency: adapter.concurrency });
}

// A store for a repo address and a token (or `anonymous: true` to read a public repo with none). Without a branch it uses the repo's default one, which also proves that the repo and the
// token work. Throws the errors of hosts/errors.js, with messages meant to be shown as they are.
export async function storeFromUrl(url, { token, branch, folder = '', anonymous = false, fetch = (...a) => globalThis.fetch(...a) } = {}) {
  const parsed = parseRepoUrl(url);
  if (!parsed) throw new Unsupported('Enter the repo address, for example https://github.com/you/data.git');
  const t = token || parsed.token;
  if (!t && !anonymous) throw new Unsupported('Enter an access token.');
  const adapter = await detectHost(parsed, fetch);
  const repo = adapter.repoPath(parsed.segments);
  if (!repo) throw new Unsupported(`${adapter.label} repos have the address ${adapter.id === 'gitlab' ? 'host/group/project' : 'host/owner/name'}.`);
  const ctx = { repo, origin: parsed.origin, token: t, fetch };
  if (!branch) {
    const info = await adapter.create(ctx).repoInfo();
    if (info.canWrite === false && !anonymous) throw new Unsupported('The token can read this repo but not write to it. Give it write access.', { host: adapter.id });
    branch = info.defaultBranch;
  }
  return createStore(adapter.id, { ...ctx, branch, folder });
}

