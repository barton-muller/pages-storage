# pages-storage

**Remote storage for static sites, using each person's own git account.** Your page reads and writes files in a git repo the person owns, on GitHub, GitLab, Codeberg or any Forgejo or Gitea server. No server, no database, no passwords. The data stays with its owner, with history, diffs and revert.

There are two ways for a person to connect, and the same data calls work with both:

| | Sign in with GitHub | An access token, any host |
|---|---|---|
| Host | GitHub | GitHub, GitLab (subgroups too), Codeberg, Forgejo, Gitea |
| The person | Presses a button, approves, picks repos | Pastes the repo address and a token |
| What you run | One small Cloudflare relay (it holds a secret, no data) | Nothing |
| Code | `createClient()` from `pages-storage/client` | `storeFromUrl()` from `pages-storage/store` |
| Merging several devices | `syncFiles()` over a store | `syncFiles()` over a store |

![How sign-in works: the site, GitHub, the relay and the person's own repo](docs/how-it-works.svg)

**Sign in with GitHub.**
1. **Sign in.** Your page sends the person to GitHub. They approve and pick which repos the app may use. GitHub sends them back with a one-time code.
2. **Relay.** Your page hands the code to the relay, which adds the app's client secret and returns a token. The relay is used at sign-in and again about every 8 hours to renew the token. It never sees the data, and it keeps nothing.
3. **Storage.** From then on your page calls GitHub directly with that token, and reads and writes files in the person's repo.

One GitHub App and one relay serve every site you list. All pages under one GitHub Pages address share a sign-in. Each extra domain you add asks for one more sign-in, then works the same. Several apps, or several screens of one app, can use the same repo, so a phone app, a dashboard and an AI agent can all work on the same data.

**With a token, on any host.** GitHub's sign-in is the only step that needs a relay, because GitHub's token endpoint has no CORS and needs a secret. A page can call the APIs of GitHub, GitLab and Codeberg directly, so a person who pastes a token needs no relay at all. One store per host hides the differences: the same calls, the same errors, one commit per sync. How the hosts are kept in step, and how to add one: [docs/HOSTS.md](docs/HOSTS.md).

**Merging.** When several devices write the same repo, `syncFiles()` does a three-way merge against the last synced state, writes the result in one commit, and merges again if someone committed in the meantime. [Rules and examples](docs/GUIDE.md#merging-and-other-git-hosts).

**Size limit:** it suits settings, notes, plans and small records, not images, uploads or heavy write traffic: every save is a commit, and `read` and `write` handle files up to about 1 MB each. More in [Limits](docs/GUIDE.md#limits).

**[Try the live example](https://barton-muller.github.io/pages-storage/).** Sign in with GitHub, use the demo (no account needed), or open *Advanced* and connect a repo on GitHub, GitLab or Codeberg with a token. It browses a repo and creates, edits and deletes text files. The source is [`docs/index.html`](docs/index.html) and [`docs/app.js`](docs/app.js).

## Set up the GitHub sign-in

Only needed for "Sign in with GitHub". For tokens, skip to [Any host, with a token](#any-host-with-a-token).

1. **Make a GitHub App.** It gives you a Client ID and a client secret. Takes 5 minutes. Optional: allow *Repository creation*, so your app can create a private repo for a new user with `createRepo()`. [Fields to fill in](docs/GUIDE.md#1-make-a-github-app).
2. **Deploy the relay.** This button copies the repo into your GitHub account and deploys it to Cloudflare. It asks for the Client ID, the client secret and the list of sites that may use it. Then put the relay's address into the GitHub App's Setup URL as `<relay address>/return`.

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/barton-muller/pages-storage)
3. **Add it to your app.**
   ```
   npm install git+https://github.com/barton-muller/pages-storage.git#v0.3.0
   ```
   ```js
   import { createClient } from 'pages-storage/client';

   const gh = createClient({ clientId, relay, appSlug, folder: 'my-app' });
   await gh.handleReturn();                          // on every page load
   if (!(await gh.signedIn())) gh.signIn();          // sends the person to GitHub and back

   const [repo] = await gh.repos();                  // repos they installed the app on
   const file = await gh.read(repo.full, 'data.json');            // { text, sha, etag } or null
   await gh.write(repo.full, 'data.json', text, file?.sha);       // throws Conflict if it changed meanwhile
   await gh.writeMany(repo.full, { 'a.json': a, 'b.json': b });  // several files in one commit
   const versions = await gh.history(repo.full, 'data.json');     // older versions, to restore
   ```
   Or copy [`client/ghstore.js`](client/ghstore.js), which has no dependencies. To build without GitHub at all, use `createDemoClient()` from `pages-storage/client/demo`: same calls, files kept in the browser.

## Any host, with a token

```
npm install git+https://github.com/barton-muller/pages-storage.git#v0.3.0
```
```js
import { storeFromUrl } from 'pages-storage/store';
import { syncFiles } from 'pages-storage/merge';

// The address as copied for git clone, and a token with write access to that repo.
// GitHub, GitLab (also group/subgroup/project), Codeberg, Forgejo, Gitea. The branch defaults to the repo's default.
const store = await storeFromUrl('https://gitlab.com/you/data.git', { token });

const { files, base } = await syncFiles(store, { files: myFiles, base: myBase });   // merge, one commit, retry on conflict
```

Errors are the same on every host and say what to do: `Unauthorized`, `NotFound`, `HostUnreachable`, `RateLimited`, `Conflict`, `Unsupported`, and `ApiMismatch` when a host answers in a way an adapter does not expect (the message names the call and the file to fix). Keep the token out of `localStorage` and read the [XSS notes](docs/GUIDE.md#security) first.

## Read next

The **[full guide](docs/GUIDE.md)** says what this is good for, how it works in more depth, what every setting means, how to add more sites and domains, how to merge data from several devices, the limits, and what to check when something fails. **[docs/HOSTS.md](docs/HOSTS.md)** is for adding a git host and for keeping all hosts consistent.

## What is in this repo

| Path | What |
|---|---|
| `index.js`, `wrangler.toml` | The relay, a Cloudflare Worker |
| `client/ghstore.js` | Browser client for the GitHub sign-in: token renewal, read, write, list, remove |
| `client/store.js`, `client/hosts/` | Stores for any git host from an address and a token. One shared store, one small adapter per host, shared errors |
| `client/merge.js` | `syncFiles` and the merge rules |
| `client/demo.js` | The same interface as the client over `localStorage`, for demos and tests |
| `client/testing/` | Fake servers for every host and the conformance suite that all adapters must pass |
| `scripts/live-check.mjs` | Runs the adapter calls against a real repo |
| `docs/index.html`, `docs/app.js` | The example app. GitHub Pages serves the `docs/` folder, so it is also the live site |
| `examples/pages-home` | A home page that forwards after install, for setups without `/return` |
| `docs/GUIDE.md`, `docs/HOSTS.md`, `docs/*.svg` | The guide, the host contract and the diagram |

## Versions

[Semver](https://semver.org/), tagged `v0.3.0` and so on. See the [changelog](CHANGELOG.md). Before 1.0 a minor version may change the client API, so pin a tag or commit. `GET /` on your relay shows which version it runs.

## Test

`npm test` runs the checks on the relay, the client, the demo backend, the merge rules and every git host adapter against a fake server of its host. They need Node 18 or newer and no network. `node scripts/live-check.mjs <repo address>` runs the adapter calls against a real repo (read only without a token; with `--token T --write` it also writes, on a throwaway branch).

## Publishing the example

Settings, Pages, Source: *Deploy from a branch*, branch `main`, folder `/docs`. After editing anything in `client/` that the example uses (`ghstore.js`, `store.js`, `merge.js`, `conflict.js`, `demo.js`, `hosts/`), run `npm run sync-docs` so the site gets the same copies. A test fails if they differ.

## Licence

[MIT](LICENSE).
