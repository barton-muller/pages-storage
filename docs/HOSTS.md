# Git hosts

How pages-storage talks to GitHub, GitLab, Forgejo, Gitea and Codeberg, and how to add another host without breaking the others.

## The layers

```
your app            syncFiles(store, { files, base, merge })           merge.js     merge rules, no host knowledge
   |
store               fetch() read() commit() repoInfo() ensureBranch()  hosts/store.js   the behaviour every host shares
   |
adapter ("ops")     six calls translated to one host's API             hosts/github.js, gitlab.js, forgejo.js
   |
http                errors, JSON, shape checks                         hosts/http.js
```

Everything that must behave the same on every host lives in `hosts/store.js`: the head check, create versus update, deletes of files that are not there, folders, empty repos, a missing repo versus a missing branch, branches. An adapter only says how its host spells six things:

| Call | Returns |
|---|---|
| `repoInfo()` | `{ defaultBranch, canWrite }`. `canWrite` is `undefined` when the host does not say |
| `branchHead(branch)` | the commit id, or `null` when the branch does not exist |
| `listFiles(commit)` | `{ path: contentId }` of every file at that commit, all pages |
| `readBlob(id)` | the text of a file |
| `commit(branch, parent, list, message)` | the new commit id. One commit for `list`, a list of `{ op: 'create' \| 'update' \| 'delete', path, text, id }`. Throws `Conflict` when the host says the files or the branch are not as the commit assumed |
| `createBranch(name, from)` | `true` when created, `false` when it existed |

So an adapter is about 60 lines, and nothing in it decides behaviour.

## Which API each host uses

| Host | API | Atomic commit | What refuses a commit that lost a race (`capabilities.concurrency`) |
|---|---|---|---|
| GitHub | REST, Git data API | tree, commit, then move the branch without force | `branch`: the move is refused when it is not a fast-forward |
| GitLab | REST v4 | `POST /repository/commits` with actions | `files`: `last_commit_id` of every file we update or delete |
| Forgejo, Gitea, Codeberg | REST v1 (Gitea 1.20 or newer) | `POST /contents` with operations | `files`: the `sha` of every file we update or delete |

`branch` means any commit on a moved branch is refused. `files` means a commit that touches other files than the ones that changed goes through, which is what a merge wants. Both are tested for every host.

None of the hosts takes the first commit of an empty repo through these APIs in a way we have verified, so `createOnEmpty` is `false` everywhere and the store says so: "Add a first commit (a README) on the host, then connect."

## Errors

Every adapter throws these (`hosts/errors.js`), so a caller handles them once. The messages are written to be shown as they are.

| Error | Meaning |
|---|---|
| `Conflict` | the data changed since it was read: fetch, merge, try again |
| `Unauthorized` | the token is wrong, expired or lacks permission |
| `NotFound` | the repo does not exist, or the token cannot see it |
| `RateLimited` | the host asked us to slow down |
| `HostUnreachable` | no answer: wrong address, no network, or the server does not allow web pages (CORS) |
| `Unsupported` | something this host or adapter does not do, said plainly |
| `ApiMismatch` | the host answered in a shape the adapter does not expect |

**`ApiMismatch` is how you find out that an API needs translating.** Every answer the adapter reads is checked (`need()` in `hosts/http.js`). When a field is missing the error says which call, which field, which host and which file to open:

> GitLab answered GET /repository/branches/main in a way this adapter does not understand (missing "commit.id"). Either GitLab's API changed, or this is not a GitLab server. The adapter is client/hosts/gitlab.js.

Without that check a changed API shows up as `undefined is not an object` somewhere else.

## Keeping the hosts in step

`node client/hosts.test.mjs` runs one conformance suite (`client/testing/conformance.js`) against a fake server of every host. The fakes (`client/testing/fakes/`) share one in-memory git (`client/testing/model.js`) and are as strict as the real APIs are about what a request must contain. The suite covers: empty repos, missing repos, wrong tokens, paging, create, update, delete, no-op commits, conflicts and races, empty files, unicode and CRLF, folders, branches, a wrong-shaped answer on every route, no network and rate limits. It also runs the merge engine over every host with two devices.

A test fails if an adapter has no fake, so a host cannot be added without passing the suite. To check that the suite really notices: break an adapter on purpose (return after the first page, drop a `need()`, force-push) and it goes red. Ten such breaks were tried and all were caught.

The fakes are our reading of each API, so they can be wrong. `scripts/live-check.mjs` runs the same calls against a real repo:

```
node scripts/live-check.mjs https://gitlab.com/group/project.git                       read only, public repo, no token
node scripts/live-check.mjs https://codeberg.org/you/data.git --token T --write        also writes on a throwaway branch
```

`--write` makes the branch `pages-storage-live-check` from the default branch, creates, updates and deletes a file there, and checks that a stale commit is a `Conflict`. It never touches the default branch. Run it after changing an adapter, and when a host announces API changes.

**What has been checked against the real hosts** (read side, public repos): GitLab, including a nested group path, and Codeberg. GitHub has not been run live from here. The write side is checked against the fakes only, until someone runs `--write` with a token. The message GitLab sends when a file changed since `last_commit_id` is matched by wording (`changed since`, `already exists`, `doesn't exist`); if GitLab words it differently, the commit fails with its own message instead of a `Conflict`, which is loud and safe, and the fix is one line in `hosts/gitlab.js`.

## Adding a host

1. Write `client/hosts/<name>.js` in the shape of `gitlab.js`: `id`, `label`, `known` (host names that need no probing), `concurrency`, `repoPath(segments)`, `create(...)` returning the six calls, and `probe(origin, fetch)` for self-hosted servers. Use `createHttp` and `need`: never read a field without checking it.
2. Add it to `hosts` in `client/hosts/index.js`. Put it after hosts whose probe is more specific.
3. Write its fake in `client/testing/fakes/<name>.js` with `createFakeServer`. List every route the adapter uses in `routes`, and the ones whose answer is not read in `unread`. Make the fake refuse what the real host refuses.
4. `node client/hosts.test.mjs` until it passes. Run `scripts/live-check.mjs` against a real repo.
5. If the host's CORS rules differ, say so in the guide.

## CORS

A web page can call a host only if the host allows the page's origin. Checked with real preflight requests: `api.github.com`, GitLab's API (`/api/v4`) and Codeberg's API (`/api/v1`) allow any origin for `GET`, `POST`, `PUT`, `PATCH` and `DELETE` with an `Authorization` header. GitLab also exposes `X-Next-Page` to scripts, which the paging needs. None of the three allows the git protocol itself (`info/refs`) to web pages, which is why the adapters use the REST APIs. A self-hosted server needs CORS turned on for the site (`[cors]` in Forgejo's and Gitea's `app.ini`, an `Access-Control-Allow-Origin` rule in front of GitLab).
