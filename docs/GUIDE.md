# Guide

This guide explains what pages-storage is for, how it works, and every setting you fill in. For the short version, see the [README](../README.md).

- [What problem this solves](#what-problem-this-solves)
- [How it works](#how-it-works)
- [Set up the GitHub sign-in](#set-up): [1. GitHub App](#1-make-a-github-app), [2. Relay](#2-deploy-the-relay), [3. Your app](#3-add-it-to-your-app)
- [Several sites and domains](#several-sites-and-domains)
- [Working with the data](#working-with-the-data)
- [Merging and other git hosts](#merging-and-other-git-hosts)
- [Limits](#limits)
- [Security](#security)
- [Updating and versions](#updating-and-versions)
- [When something fails](#when-something-fails)

## What problem this solves

A static site, such as one on GitHub Pages, has no backend. The usual ways to keep a person's data all cost something:

- **Browser storage** lives on one device, and a browser can clear it. iOS does.
- **Your own backend** needs hosting, a database, accounts, and a privacy policy. You carry the risk of holding other people's data.
- **A hosted backend service** needs its own sign-up for you and for your users, and locks the data in.

pages-storage uses something every developer, and a growing number of other people, already has: an account on a git host such as GitHub, GitLab or Codeberg. The data goes in a repo the person owns. You never hold it, and neither does the relay.

What you get:
- **No server and no database to run.** The relay is a function of about 110 lines on Cloudflare's free tier. It holds one secret and no data.
- **Identity for free.** "Sign in with GitHub", or a pasted token for GitHub, GitLab, Codeberg, Forgejo and Gitea, and no passwords.
- **The person owns the data.** It is files in their repo, with history, diffs and revert. They can read it, edit it, or take it elsewhere.
- **Several interfaces on one set of data.** A phone app, a dashboard, a script and an AI agent can all read and edit the same files. The agent just needs the repo.
- **Sharing.** Give someone else access to the repo and they see the same data.
- **Works offline-first.** Keep a local copy and sync when online. Conflicts are detected for you.

It suits personal tools, planners, notes, trackers, small-team data, and content editors for a static site.

It does not suit:
- **Large or binary data.** Files are limited to about 1 MB through this route.
- **Many writes per second.** Every save is a commit.
- **Anonymous visitors.** People need an account on a supported git host.
- **Fine-grained access between strangers**, or logic that must run on a server.

For a comparison with the [remoteStorage](https://remotestorage.io/) protocol: that is a real standard with many compatible servers, and this is not one. It trades portability for a provider almost everyone already has, plus history and AI-editable files.

## How it works

This section describes the GitHub sign-in. Connecting with a token on any host is described in [Merging and other git hosts](#merging-and-other-git-hosts).

Three parties: the **site** (static, in the browser), **GitHub**, and the **relay** (a Cloudflare Worker).

**Why a relay at all.** GitHub's token endpoint needs the app's *client secret*, and a web page cannot keep a secret. It also does not allow calls from a web page (no CORS). So the one step that needs the secret runs on the relay. Everything else the site does itself.

**Sign-in**
1. The site makes a random *verifier*, sends its hash (the *challenge*) to GitHub, and sends the person to `github.com/login/oauth/authorize`. This is PKCE: only the browser that holds the verifier can finish the sign-in.
2. The person approves. GitHub redirects to the site's address with a one-time `code`.
3. The site posts `code`, the verifier and the redirect address to the relay's `/token`. The relay adds the client secret, calls GitHub, and returns an access token (valid 8 hours) and a refresh token (about 6 months).
4. The site keeps both in the browser and uses the access token to call `api.github.com` directly.
5. Before the access token runs out, the client asks the relay's `/refresh` for a new one. Nothing else goes through the relay.

**Which repos.** The GitHub App has the *Contents* permission. A person installs the app on the repos they choose, and the token can touch only those. `gh.repos()` lists them. `gh.installUrl()` opens GitHub's page to change the choice, and the relay's `/return` brings the person back to your site afterwards.

**Reading and writing.** GitHub's Contents API is a small key-value store: the path is the key, the file is the value. Every read returns a `sha`. A write sends that `sha` back, and if the file changed in between, GitHub refuses with a conflict. The client turns that into a `Conflict` error.

**What the relay sees.** The code and the verifier at sign-in, and the refresh token at renewal. It passes them on and stores none of it. It refuses callers whose origin is not in `ALLOWED_ORIGINS`, and redirect addresses outside those origins.

## Set up

You need a GitHub account and a free [Cloudflare](https://www.cloudflare.com/) account. All of it can be done from a phone browser.

### 1. Make a GitHub App

Use a **GitHub App**, not an OAuth App. An OAuth App can only ask for access to all of someone's private repos. A GitHub App is installed on the repos the person picks and has only the permission you give it.

On github.com open *Settings, Developer settings, GitHub Apps, New GitHub App*.

| Field | Value |
|---|---|
| GitHub App name | A unique name. It becomes the slug in `github.com/apps/<slug>`. Note the slug. |
| Homepage URL | One of your sites. |
| Callback URL | The address of each site that will sign people in, with the trailing `/`. You can add several. For every page of one GitHub Pages account, add `https://<you>.github.io/` and turn on wildcard matching for it. Wildcard matching lets any page under that address receive sign-in codes, so use it only when you control every page there. |
| Expire user authorization tokens | Ticked. |
| Request user authorization (OAuth) during installation | **Unticked.** If ticked, GitHub sends people to the *first* callback URL after installing, which may not be the site they came from. |
| Enable Device Flow | Unticked. |
| Setup URL | Leave empty for now. After step 2, set it to `<relay address>/return`. |
| Redirect on update | Ticked, so adding or removing repos also returns people to the site. |
| Webhook, Active | Unticked. |
| Repository permissions, Contents | **Read and write.** |
| Repository permissions, Repository creation | **Read and write.** Optional. It lets your app create a private repo for the person with one call, `createRepo()`, so they do not have to leave your site. Skip it if people always bring a repo of their own. People who already installed the app are asked to approve the new permission. |
| Where can this GitHub App be installed | *Only on this account*, or *Any account* if other people should use it. |

Create it. On the app's page copy the **Client ID**, which is public, and generate a **client secret**, which is shown once. You do not need a private key, so skip the JWT pages.

### 2. Deploy the relay

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/barton-muller/pages-storage)

The button copies this repo into your GitHub account, deploys it with Cloudflare's Workers Builds, and shows a form for the settings:

| Setting | Value |
|---|---|
| `GITHUB_CLIENT_ID` | The Client ID from step 1. It starts with `Iv`. Check it character by character: `l` and `1`, `I` and `l` look alike on a phone. |
| `GITHUB_CLIENT_SECRET` | The client secret from step 1. Paste only the secret, with no spaces or quotes. |
| `ALLOWED_ORIGINS` | The sites that may use the relay, comma-separated, each as scheme and host with no path and no trailing slash: `https://you.github.io,https://example.com`. One entry covers every page under it. |

Nothing personal is stored in the repo copy. Later pushes to your copy redeploy it and the settings stay. Change a setting in the Worker's *Settings, Variables and Secrets*, and it applies at once.

The deploy gives you the relay's address, such as `https://pages-storage.<you>.workers.dev`. Open it. You should see `{"name":"pages-storage","version":"0.2.0","configured":true}`. `configured: false` means a setting is missing.

Now go back to the GitHub App and set **Setup URL** to `<relay address>/return`.

**Without the button.** Clone the repo and run:
```
npm install
npx wrangler login
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put ALLOWED_ORIGINS
npx wrangler deploy
```
Or in the dashboard: *Workers & Pages, Create, Import a repository*, deploy command `npx wrangler deploy`, then add the three settings under *Settings, Variables and Secrets*.

**Check it from a computer:**
```
curl -X POST <relay address>/token -H 'Origin: https://you.github.io' -H 'Content-Type: application/json' -d '{}'
```
`{"error":"bad_request"}` is the right answer.

### 3. Add it to your app

Three values go into the app, and all are public: the Client ID, the relay address and the app slug.

```
npm install git+https://github.com/barton-muller/pages-storage.git#v0.2.0
```
```js
import { createClient, Conflict } from 'pages-storage/client';

const gh = createClient({
  clientId: 'Iv…',
  relay: 'https://pages-storage.<you>.workers.dev',
  appSlug: 'my-app-slug',
  folder: 'my-app',
});

await gh.handleReturn();                        // every page load; finishes a sign-in and tidies the URL
if (!(await gh.signedIn())) gh.signIn();        // redirects to github.com and back

const repos = await gh.repos();                 // [{ full: 'you/data', branch: 'main' }]
if (!repos.length) location.href = gh.installUrl();   // person picks repos, then returns here

const file = await gh.read('you/data', 'data.json');        // { text, sha, etag } or null
const sha = await gh.write('you/data', 'data.json', JSON.stringify(data), file?.sha);
```

| Call | What it does |
|---|---|
| `signIn()`, `handleReturn()`, `signOut()` | The sign-in flow. `handleReturn()` returns the new sign-in, or `null`. |
| `signedIn()`, `login()`, `auth()`, `token()` | Current state. `token()` renews the access token when it is about to expire. |
| `repos()`, `installUrl()` | Repos the app is installed on, and GitHub's page to change that. |
| `createRepo(name, { description?, isPrivate? })` | Creates a private repo (with a first commit) for the person and returns `{ full, branch }`. Needs the *Repository creation* permission. Afterwards check that `repos()` lists it. If it does not, the app still has to be installed on the new repo, so send the person to `installUrl()`. |
| `read(repo, path, branch?, etag?)` | `{ text, sha, etag }`, or `null` if missing. With the `etag` of an earlier read you get `{ notModified: true }` for an unchanged file, which GitHub does not count against the rate limit. |
| `list(repo, dir?, branch?)` | The entries of a folder: `{ name, path, type, sha, size }`. |
| `write(repo, path, text, sha?, branch?, message?)` | Creates or replaces a file and returns its new `sha`. Pass the `sha` of the version you read. A stale one throws `Conflict`. |
| `remove(repo, path, sha, branch?)` | Deletes a file. The old content stays in git history. |
| `writeMany(repo, { path: text \| null }, { message?, base?, branch? })` | Several files in **one commit**, with `null` deleting a file. Returns `{ commit }`. With `base` (a commit sha from `head()` or an earlier `writeMany`) it throws `Conflict` if the branch has moved, so nothing is half-written. Without `base` it commits on top of whatever the branch is now. Use it to save related files together and to cut commit noise. |
| `history(repo, path, { limit?, branch? })` | The commits that touched a file, newest first: `{ sha, message, author, date }`. Pass a `sha` as the branch argument of `read()` to get the file as it was then. Gives you undo, restore and "who changed this". |
| `head(repo, branch?, etag?)` | The branch's current commit as `{ sha, etag }`. Pass the `etag` of an earlier call to get `{ notModified: true }`, which GitHub does not count against the rate limit. |
| `changes(repo, sinceSha, branch?)` | `{ head, files: [{ path, status }] }`: what changed since a commit, limited to the client's folder. Good for fetching only what is new. GitHub lists at most 300 files; `truncated` says if there may be more. |
| `createRepoFromTemplate(template, name, { description?, isPrivate? })` | Makes a private repo from a template repo (`"owner/name"`, marked as a template on GitHub), with all its files, and resolves once it has its first commit. Needs the *Repository creation* permission. Use it so new users start with your app's starter files. |

Options of `createClient`:

| Option | Meaning |
|---|---|
| `clientId`, `relay`, `appSlug` | The three public values. |
| `folder` | Keeps every path under this folder, so several apps can share one repo. A convention only: the app's access covers the whole repo. |
| `name` | Prefix for what the client stores in the browser. Use one name per app when apps share an origin. |
| `storage` | `{ get, set, del }`, each async, to keep the sign-in somewhere other than `localStorage`, such as IndexedDB. Sites that point at the same storage share a sign-in. |
| `cleanUrl` | The address to show after sign-in returns. Default: the page's own path and hash. |

**No build step:** copy [`client/ghstore.js`](../client/ghstore.js). It has no dependencies. TypeScript types are in `ghstore.d.ts`.

**Build or test without GitHub:** `createDemoClient()` from `pages-storage/client/demo` has the same calls and keeps files in `localStorage`. Swap it for `createClient()` when you go live. Pass `seed: { 'hello.txt': 'Hi' }` to start with some files, and call `reset()` to restore them. The [example page](index.html) does this with a "Try the demo" button.

**Merging is your job.** The storage layer tells you the file changed. When two devices edit one file, read again, merge your changes into the new version, and write again. Keeping each record separate, with an `updatedAt`, and taking the newest per record works well. Go Find Yourself does this.

## Several sites and domains

- **Same GitHub Pages account.** One origin, `https://<you>.github.io`, covers every project page. The browser shares storage between them, so with the same `name` and `storage` a person signs in once for all.
- **Another domain.** Add its origin to `ALLOWED_ORIGINS` in the Worker's settings (no redeploy needed), add its address as another Callback URL on the GitHub App, and have the site add `state=<its address>` to the install link, which `gh.installUrl()` does. The browser stores the sign-in per origin, so a person signs in once on each domain. GitHub remembers the approval, so it is one tap.
- **Several interfaces, one dataset.** Point them at the same repo and use a shared `folder`, or different folders for different apps. A dashboard and an editor can both use `my-data/`.
- **Someone else's site.** They can use your relay if you add their origin, but then they sign people in through your GitHub App, under your app's name. Most people should deploy their own.

## Working with the data

- **It is plain files in a repo.** Open them on github.com, clone the repo, or let an AI agent edit them. The app picks the changes up on the next read.
- **Every save is a commit**, with the message you pass to `write`. You get history for free. Save when something changes, not on every keystroke.
- **Private by default.** Keep the data repo private. The app token reaches only the repos the person chose.
- **Branches.** Pass `branch` to read and write on another branch, for example one per person.

## Merging and other git hosts

Two devices that write to the same repo need a rule for what happens when both changed something. `pages-storage/merge` has the rules and `pages-storage/store` has the stores they run on. Neither needs the relay.

```js
import { syncFiles, merge3Keys, mergeRecords } from 'pages-storage/merge';
import { githubStore, storeFromUrl } from 'pages-storage/store';

const store = await githubStore(gh, repo);                             // after sign-in with the relay
// or, with no sign-in and no relay, from the address of any repo and a token (GitHub, GitLab, Codeberg, Forgejo, Gitea):
// const store = await storeFromUrl('https://gitlab.com/group/data.git', { token });

let base = null;                                                       // keep what the last call returned, for example in IndexedDB
const result = await syncFiles(store, { files: myFiles, base, merge: myMerge, include: (p) => p.startsWith('my-app/') });
myFiles = result.files; base = result.base;
```

`syncFiles` is a three-way merge of the last synced state (`base`), the files on this device and the files in the store. It writes what changed in one commit that is based on the state it merged. If someone else committed in the meantime, the commit is refused with `Conflict` and the merge runs again on the new state, up to three times. Merging twice gives the same result, so a retry is safe.

The default rule per file: a change wins over no change, a change wins over a delete, and when both sides changed the file the local one wins. For JSON files pass your own `merge(path, base, local, remote)` and use the helpers:

- `merge3Keys(base, local, remote)` for flat settings. Per key, a change on one side wins over no change on the other. A key changed on both sides goes to local, or to remote with `{ preferRemote: true }`. Use `preferRemote` on the first sync of a device so it picks up what the repo has.
- `mergeRecords(local, remote)` for collections of records with an `updatedAt`. The newest wins and deletes are records with `deleted: true`, so a delete is not undone by a device that still has the record.

`storeFromUrl(url, { token, branch })` takes the address as people copy it for `git clone` (the token can sit in front of the host, `https://token@host/group/name.git`). It tells the host from the address: github.com, gitlab.com and codeberg.org are known, and any other server is asked which API it speaks. Without a branch it uses the repo's default one, and it checks that the token can write. GitLab addresses may have subgroups (`group/sub/project`).

The stores share one implementation of everything that has to behave the same, and each host adds only the translation of six calls to its API. The errors are the same on every host: `Conflict`, `Unauthorized`, `NotFound`, `RateLimited`, `HostUnreachable`, `Unsupported`, and `ApiMismatch` when a host answers in a shape the adapter does not expect, with the call and the file to fix in the message. [HOSTS.md](HOSTS.md) has the contract, the table of what each host's API does, how the hosts are kept in step by one test suite, and how to add a host. `storeClient(store)` wraps any store in the `read`, `write`, `list` and `remove` calls of the GitHub client, which is how the example page's collapsed **Advanced** section works with every host from one address and a token.

**Which hosts work from a web page.** A page can only call servers that allow its origin (CORS). `api.github.com`, GitLab's API and Codeberg's API do. For a self-hosted server turn on CORS for your site. The git protocol itself (`git clone` over HTTPS) is not callable from a page on these hosts, and neither are `github.com`'s sign-in endpoints. For those you need a relay, or a native app: the [FitoTrack fork](https://github.com/barton-muller/fitotrack-githubsync) uses JGit and the same merge rules on Android.

**A token in the page.** With `storeFromUrl` the person pastes an access token. Give it write access to one repo and nothing else, and keep it out of `localStorage`: the example keeps it in session storage, so it is gone when the tab closes. That is better, not safe: any script on the page can read either. See [Protecting against XSS](#security).

## Limits

- Around 1 MB per file through `read` and `write`, which use the Contents API. `writeMany` goes through the Git data API, which GitHub documents with a much higher per-file limit, but `read` still uses the 1 MB route, and I have not tested large files. Keep data as a few JSON or text files.
- One request per file. No transactions across files.
- 5,000 requests an hour per user. Plenty for one person, and conditional reads (`etag`) cost nothing.
- Reads can lag a few seconds behind a write because of GitHub's caching.
- People need an account on a supported git host (GitHub, GitLab, Codeberg, Forgejo, Gitea).
- Access tokens last 8 hours and the client renews them. After about 6 months without use the person signs in again.

## Security

- The client secret exists only as a Cloudflare secret. Never put it in a repo, a website, a chat or a log.
- The relay refuses any origin not in `ALLOWED_ORIGINS` and any redirect address outside those origins. Answers are `Cache-Control: no-store`.
- Tokens pass through the relay in memory only. If you change the code, do not log or store them.
- PKCE ties each code to the browser that asked for it, so a stolen code is useless.
- **Tell people what a site can do.** An app installed on a repo can read and write every file in it, and so can the site that holds the token. The example page says so before sign-in and offers to create a private test repo. Do the same, and suggest a separate repo for the data.
- The token lives in the browser's storage. Treat the site like any page that holds a login: no third-party scripts you do not trust.
- **Protecting against XSS.** No browser storage is safe from a script that runs on your origin, so stop the injection and limit what a stolen token can do.
  - **Content Security Policy.** GitHub Pages cannot set headers, so use a meta tag. The example page has one: `default-src 'none'; script-src 'self'; connect-src https://api.github.com <your relay>; base-uri 'none'; form-action 'none'`. Scripts come only from your own files (no inline scripts, which is why the example's code is in `app.js`), and the page can only talk to GitHub and your relay, so an injected script cannot send a token anywhere else. `style-src 'unsafe-inline'` is a small risk many pages accept. Add `require-trusted-types-for 'script'` on Chromium.
  - **Treat data from the repo as untrusted.** An AI agent, a collaborator or a bad import can write it. Put it on the page with `textContent`, never `innerHTML`. If you must render Markdown or HTML, sanitize it with DOMPurify. Libraries that take HTML strings (for example Leaflet tooltips) need the same care. Escape first.
  - **Self-host scripts or pin them with Subresource Integrity.** A compromised CDN script is an XSS.
  - **One origin per trust level.** Every project page under `you.github.io` shares one origin and so one token and one IndexedDB. An XSS in any of them reaches all of them. Put sensitive apps on their own subdomain or custom domain, or accept the shared risk on purpose.
  - **Limit the damage.** The 8-hour access token, a GitHub App that only reaches the repos you chose, Contents permission only, and a private data repo. For pasted tokens, a fine-grained token on one repo with a short expiry.
- To cut everyone off at once, generate a new client secret in the GitHub App and update `GITHUB_CLIENT_SECRET`.
- Wildcard callback URLs let any page under that address receive codes. Use them only for addresses you fully control.

## Updating and versions

- The repo follows [semver](https://semver.org/) with tags (`v0.2.0`) and a [changelog](../CHANGELOG.md). Before 1.0, a minor version may change the client API, so pin a tag or commit in your app.
- **Client:** change the tag in `package.json` and run `npm install`. Read the changelog first.
- **Relay:** your copy of the repo is separate. To update, pull the new code into it (on GitHub, *Sync* if it is a fork, or copy files) and push. Workers Builds redeploys, and `GET /` on the relay shows the new version.
- The relay and the client are meant to be compatible within one minor version. A newer client against an older relay works unless the changelog says otherwise.

## When something fails

| What you see | Cause and fix |
|---|---|
| `origin_not_allowed` | The site's origin is not in `ALLOWED_ORIGINS`. Check scheme and host, no path, no trailing slash. |
| `redirect_not_allowed` | The sign-in redirect address is on an origin that is not in `ALLOWED_ORIGINS`. |
| `relay_not_configured`, or `configured: false` at `GET /` | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` or `ALLOWED_ORIGINS` is missing in the Worker. |
| `incorrect_client_credentials` | The Client ID and secret in the Worker do not match the GitHub App. Re-enter both, paste the secret alone, and generate a new secret if unsure. |
| `bad_verification_code` | The code was used twice or expired. Start the sign-in again. |
| `redirect_uri_mismatch` (from GitHub) | The site's address is not in the app's Callback URLs. Add it with the trailing `/`, or turn on wildcard matching. |
| 404 after installing the app on a repo | The Setup URL is wrong. Set it to `<relay address>/return`. |
| After installing, you land on the app page, not your site | The install link lacks `state`, or the site's origin is not in `ALLOWED_ORIGINS`. Use `gh.installUrl()`. |
| An error from a store (`Unauthorized`, `NotFound`, `HostUnreachable`, `ApiMismatch`, …) | See the error table in [HOSTS.md](HOSTS.md#errors). The message says which host and which call. |
| `repos()` returns an empty list | The app is not installed on any repo yet. Send the person to `gh.installUrl()`, or call `createRepo()`. |
| `createRepo` says the app is not allowed | The GitHub App lacks the *Repository creation* permission. Add it in the app's *Permissions & events*, then approve the change on your own installation. |
| `Conflict` on write | The file changed since it was read. Read again, merge, write again. |
| `Sign-in was not started in this browser` | The return came back in a different browser or after the tab's storage was cleared. Try again in one browser. |
| Signed in on one device, not on another | Sign-in is stored per browser and origin. Sign in on each device. |
| Another site's sign-in does not carry over | Sign-in is stored per origin. Pages under one origin can share it. Other domains sign in once each. |
