# Changelog

Versions follow [semver](https://semver.org/). `package.json` holds the version, and the Worker reports it at `GET /`.
While the version is 0.x, a minor bump may change the client API. Pin a tag or commit in your app.

## 0.3.0

Client additions. Nothing removed or renamed. `Conflict` now lives in `conflict.js` and is still exported from `ghstore.js`.

- **`pages-storage/merge`:** `syncFiles(store, { files, base, merge, include })`, a three-way sync of whole files over any store with one commit and retry on conflict. `merge3Keys` for flat settings, `mergeRecords` for records with `updatedAt` and tombstones, `mergeText` as the default per-file rule.
- **`pages-storage/store`:** a store is `fetch()`, `read(id)` and `commit(expected, changes, message)`. `githubStore(client, repo)`, `forgejoStore({ url, repo, branch, token })` for Forgejo, Gitea and Codeberg with a token and no relay, `memoryStore()` for tests, and `storeClient(store)` which gives any store the `read`, `write`, `list` and `remove` calls of the GitHub client.
- **Hosts: GitHub, GitLab, Forgejo, Gitea and Codeberg.** `storeFromUrl(url, { token, branch })` takes a repo address as copied for `git clone` and a token, finds out which host it is (known names, otherwise a probe of the server's API), looks up the default branch and checks that the token can write. GitLab is new, with subgroups. A store now also has `repoInfo()`, `ensureBranch()`, `host` and `capabilities`.
- **One shared store, thin adapters.** What must behave the same on every host lives in `hosts/store.js`; each adapter in `hosts/` only translates six calls. Errors are the same everywhere (`Conflict`, `Unauthorized`, `NotFound`, `RateLimited`, `HostUnreachable`, `Unsupported`), and `ApiMismatch` names the call, the field and the adapter file when a host answers in a shape the adapter does not expect.
- **A conformance suite for all hosts.** `node client/hosts.test.mjs` runs the same scenarios against a fake server of every host, and fails if an adapter has no fake. `scripts/live-check.mjs` runs the calls against a real repo. See `docs/HOSTS.md`.
- **Changed within 0.3.0 before release:** `githubStore(client, repo)` now returns a promise and uses the same GitHub adapter; `tree()` and `blob()` on the client are gone; `forgejoStore`, `githubTokenStore` and `gitlabStore` remain as thin wrappers over `createStore`.
- **Example page:** a collapsed **Advanced** section connects to a GitHub or Codeberg repo from its address and a token. The page's script moved to `app.js` so a Content Security Policy can forbid inline scripts, and the page has one.
- **Guide:** a section on merging and other git hosts, and on protecting against XSS.

## 0.2.0

Client additions. Nothing removed or renamed.

- **`writeMany(repo, { path: text | null }, { message, base })`:** several files in one commit, deletes included, through the Git data API. With `base` (a commit sha) it fails with `Conflict` if the branch moved, which gives you a check across all the files. Without it, it starts again on the new head.
- **`history(repo, path)`:** the commits that touched a file. Pass a commit sha as the branch argument of `read()` to get that version.
- **`head(repo, branch?, etag?)` and `changes(repo, sinceSha)`:** the branch's current commit with a free ETag check, and the files that changed since a commit.
- **`createRepoFromTemplate(template, name)`:** a private repo made from a template repo, resolved once it has its first commit.
- **Demo backend:** the same calls, with a commit log behind them.
- **Example page:** shows a file's history and loads an old version for restoring.

## 0.1.0

First tagged release.

- **Relay:** `POST /token` and `POST /refresh` swap codes and refresh tokens for GitHub App user tokens (PKCE). `GET /return` sends people back to the site that started an app install. `GET /` reports the version. Allowed origins only. Keeps nothing.
- **Client (`pages-storage/client`):** sign-in with PKCE, token renewal, `repos`, `read` (with ETag), `list`, `write`, `remove`, a folder per app, pluggable token storage, TypeScript types.
- **`createRepo(name)`:** creates a private repo for the signed-in person. Needs the optional *Repository creation* permission on the GitHub App.
- **Demo backend (`pages-storage/client/demo`):** the same interface over `localStorage`, for demos and tests.
- **Example page:** sign in or use the demo, browse a repo, open, create, edit and delete text files, and create a private test repo with sample files.
- **Deploy to Cloudflare button:** `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `ALLOWED_ORIGINS` are asked for at deploy time.
