import { createClient, Conflict } from './ghstore.js';
import { createDemoClient } from './demo.js';
import { forgejoStore, storeClient } from './store.js';

// Fill in your own values to use real sign-in. Serve this page from an origin listed in the relay's ALLOWED_ORIGINS.
const CONFIG = {
  clientId: 'Iv23li69aGBxYokv1i8f',
  relay: 'https://pages-storage-active.barton-fna.workers.dev',
  appSlug: 'pages-storage-bm',
};

const NAME = 'pages-storage-example';
const MODE = `${NAME}:mode`;
const $ = (id) => document.getElementById(id);
const say = (t) => ($('msg').textContent = t);
const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const DEMO_FILES = {
  'README.txt': 'Welcome to the demo.\n\nThese files live only in this browser. Nothing is stored remotely.\nEdit one, make a new one, or delete them all. Reset brings them back.',
  'shopping-list.txt': 'oat milk\nlemons\ncoffee beans\nbatteries (AA)',
  'notes/ideas.md': '# Ideas\n\n- a packing list that remembers my trips\n- a recipe box\n- reading log',
  'notes/meeting.txt': 'Thursday 10:00\nAgenda: schedule, budget, who books the train.',
  'data/settings.json': '{\n  "theme": "dark",\n  "units": "metric"\n}',
};
const demo = get(MODE) === 'demo';
// A connection made with a token lives in this tab only, so closing it forgets the token.
const GIT = `${NAME}:git`;
const gitCfg = (() => { try { return JSON.parse(sessionStorage.getItem(GIT)); } catch { return null; } })();
const git = !demo && gitCfg;
const gh = demo ? createDemoClient({ name: NAME, seed: DEMO_FILES })
  : git ? storeClient(forgejoStore({ url: gitCfg.url, repo: gitCfg.repo, branch: gitCfg.branch, token: gitCfg.token }), gitCfg.repo)
  : createClient({ ...CONFIG, name: NAME });

let dir = '', file = null; // file: { path, sha }

const crumbs = () => {
  const parts = dir ? dir.split('/') : [];
  const links = [['repo', '']].concat(parts.map((p, i) => [p, parts.slice(0, i + 1).join('/')]));
  $('crumbs').replaceChildren(...links.flatMap(([label, path], i) => {
    const b = Object.assign(document.createElement('button'), { className: 'link', textContent: label });
    b.onclick = () => open(path);
    return i ? ['/', b] : [b];
  }));
};

async function open(path) {
  dir = path; file = null; $('editor').hidden = true; say('');
  crumbs();
  let items;
  try { items = await gh.list($('repo').value, dir); } catch (e) { return say(e.message); }
  $('files').replaceChildren(...(items.length ? items : [Object.assign(document.createElement('li'), { textContent: 'Empty. Create a file below.' })]).map((x) => {
    const li = document.createElement('li');
    if (!x.name) return li;
    li.append(Object.assign(document.createElement('span'), { textContent: x.type === 'dir' ? `${x.name}/` : x.name }), Object.assign(document.createElement('span'), { textContent: x.type === 'dir' || x.size == null ? '' : `${x.size} B` }));
    li.onclick = () => (x.type === 'dir' ? open(x.path) : edit(x.path, li));
    return li;
  }));
}

async function edit(path, li) {
  say('Loading…');
  try {
    const f = await gh.read($('repo').value, path);
    if (!f) return say('That file is gone.');
    file = { path, sha: f.sha };
    $('fname').textContent = path;
    $('fmeta').textContent = `${f.text.length} character${f.text.length === 1 ? '' : 's'}`;
    $('text').value = f.text;
    $('editor').hidden = false;
    document.querySelectorAll('#files li').forEach((e) => e.classList.toggle('on', e === li));
    say('');
    showHistory(path);
  } catch (e) { say(e.message); }
}

async function showHistory(path) {
  const log = await gh.history($('repo').value, path).catch(() => []);
  $('histhead').hidden = !log.length;
  $('history').replaceChildren(...log.slice(0, 8).map((c, i) => {
    const li = document.createElement('li');
    const when = c.date ? new Date(c.date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
    li.append(Object.assign(document.createElement('span'), { textContent: c.message || '(no message)' }), Object.assign(document.createElement('span'), { textContent: i ? when : `${when}, now` }));
    li.onclick = async () => {
      const old = await gh.read($('repo').value, path, c.sha);
      if (!old) return say('That version could not be read.');
      $('text').value = old.text;
      say(i ? 'Loaded an older version. Press Save to restore it.' : 'This is the current version.');
    };
    return li;
  }));
}

const fail = (e) => say(e instanceof Conflict ? 'Changed elsewhere. Press Reload, then save again.' : e.message);

$('signin').onclick = () => { localStorage.removeItem(MODE); gh.signIn(); };
$('demo').onclick = async () => { localStorage.setItem(MODE, 'demo'); await createDemoClient({ name: NAME, seed: DEMO_FILES }).signIn(); };
$('reset').onclick = async () => { await gh.reset(); location.reload(); };
$('signout').onclick = async () => { await gh.signOut(); localStorage.removeItem(MODE); sessionStorage.removeItem(GIT); location.reload(); };
$('g-connect').onclick = () => {
  const url = $('g-url').value.trim().replace(/\/+$/, ''), repo = $('g-repo').value.trim(), token = $('g-token').value.trim();
  if (!/^https:\/\//.test(url) || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !token) return say('Fill in the server (https://…), the repo as owner/name and a token.');
  sessionStorage.setItem(GIT, JSON.stringify({ url, repo, branch: $('g-branch').value.trim() || 'main', token }));
  localStorage.removeItem(MODE);
  location.reload();
};
$('repo').onchange = () => open('');
const fillRepos = async (select) => {
  const repos = await gh.repos();
  $('repo').replaceChildren(...repos.map((r) => new Option(r.full, r.full)));
  if (select && repos.some((r) => r.full === select)) $('repo').value = select;
  return repos;
};
$('mkrepo').onclick = async () => {
  $('mkrepo').disabled = true; say('Creating a private repo…');
  try {
    const made = await gh.createRepo('pages-storage-test', { description: 'Throwaway repo for the pages-storage example' });
    const repos = await fillRepos(made.full);
    if (!repos.some((r) => r.full === made.full)) {
      say(`Created ${made.full}, but the app cannot see it yet. Use "Choose other repos" and add it.`);
      return;
    }
    say('Adding sample files…');
    for (const [p, text] of Object.entries(DEMO_FILES)) if (p !== 'README.txt') await gh.write(made.full, p, text);
    await open('');
    say(`Created ${made.full} with a few sample files.`);
  } catch (e) { say(e.message); } finally { $('mkrepo').disabled = false; }
};
$('reload').onclick = () => edit(file.path);
$('save').onclick = async () => {
  try { const path = file.path; file.sha = await gh.write($('repo').value, path, $('text').value, file.sha); await open(dir); await edit(path); say('Saved.'); } catch (e) { fail(e); }
};
$('delete').onclick = async () => {
  if (!confirm(`Delete ${file.path}?`)) return;
  try { await gh.remove($('repo').value, file.path, file.sha); say('Deleted.'); open(dir); } catch (e) { fail(e); }
};
$('create').onclick = async () => {
  const n = $('newname').value.trim().replace(/^\/+/, '');
  if (!n) return say('Type a file name first.');
  const path = dir ? `${dir}/${n}` : n;
  try {
    if (await gh.read($('repo').value, path)) return say('A file with that name already exists.');
    await gh.write($('repo').value, path, '\n');
    $('newname').value = '';
    await open(dir); edit(path);
  } catch (e) { fail(e); }
};

try { await gh.handleReturn(); } catch (e) { say(e.message); }
if (!git && !(await gh.signedIn())) {
  $('out').hidden = false;
  if (!CONFIG.clientId || !CONFIG.relay) { $('signin').disabled = true; $('cfg-note').hidden = false; }
} else {
  $('out').hidden = true; $('app').hidden = false;
  $('who').textContent = await gh.login();
  $('demo-tag').hidden = !demo;
  $('demo-note').hidden = !demo; $('real-note').hidden = demo;
  if (demo || git) $('install').hidden = true; else $('install').href = gh.installUrl();
  if (git) { $('mkrepo').hidden = true; $('real-note').textContent = 'Each save is a commit in the repo. The token is kept in this tab only. This page can edit any file in the repo.'; }
  const repos = await fillRepos().catch((e) => (say(e.message), []));
  if (repos.length) await open(''); else say('No repos yet. Create a private test repo above, or choose repos you already have.');
}
