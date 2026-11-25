# pages-storage

**Remote storage for static sites, using each person's own GitHub account.** People sign in with GitHub, and your page reads and writes files in a repo they own. No server, no database, no passwords. One small Cloudflare relay does the single step GitHub will not let a web page do.

![How it works: the site, GitHub, the relay and the person's own repo](docs/how-it-works.svg)

1. **Sign in.** Your page sends the person to GitHub. They approve and pick which repos the app may use. GitHub sends them back with a one-time code.
2. **Relay.** Your page hands the code to the relay, which adds the app's client secret and returns a token. The relay is used at sign-in and again about every 8 hours to renew the token. It never sees the data, and it keeps nothing.
3. **Storage.** From then on your page calls GitHub directly with that token, and reads and writes files in the person's repo.

One GitHub App and one relay serve every site you list. All pages under one GitHub Pages address share a sign-in. Each extra domain you add asks for one more sign-in, then works the same. Several apps, or several screens of one app, can use the same repo, so a phone app, a dashboard and an AI agent can all work on the same data.

**Other hosts and merging.** The client also has [rules for merging data that several devices write](docs/GUIDE.md#merging-and-other-git-hosts) and stores for GitHub, GitLab, Forgejo, Gitea and Codeberg that work from a repo address and a pasted token, with no relay, all kept in step by one test suite ([how](docs/HOSTS.md)).

**Size limit:** files up to about 1 MB each, one request per file, and every save is a commit. It suits settings, notes, plans and small records, not images, uploads or heavy write traffic. More in [Limits](docs/GUIDE.md#limits).

**[Try the live example](https://barton-muller.github.io/pages-storage/).** Sign in with GitHub, or use the demo, which needs no account. It browses a repo and creates, edits and deletes text files. The source is [`docs/index.html`](docs/index.html), about 160 lines.

## Set up

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

## Read next

The **[full guide](docs/GUIDE.md)** says what this is good for, how it works in more depth, what every setting means, how to add more sites and domains, the limits, and what to check when something fails.

## What is in this repo

| Path | What |
|---|---|
| `index.js`, `wrangler.toml` | The relay, a Cloudflare Worker |
| `client/ghstore.js` | Browser client: sign-in, token renewal, read, write, list, remove |
| `client/demo.js` | The same interface over `localStorage`, for demos and tests |
| `docs/index.html` | The example app. GitHub Pages serves the `docs/` folder, so it is also the live site |
| `examples/pages-home` | A home page that forwards after install, for setups without `/return` |
| `docs/GUIDE.md`, `docs/*.svg` | The guide and the diagram |

## Versions

[Semver](https://semver.org/), tagged `v0.2.0` and so on. See the [changelog](CHANGELOG.md). Before 1.0 a minor version may change the client API, so pin a tag or commit. `GET /` on your relay shows which version it runs.

## Test

`npm test` runs the checks on the relay, the client, the demo backend and the merge rules. They use a pretend GitHub and need Node 18 or newer, no network.

## Publishing the example

Settings, Pages, Source: *Deploy from a branch*, branch `main`, folder `/docs`. After editing `client/ghstore.js` or `client/demo.js`, run `npm run sync-docs` so the site gets the same copies. A test fails if they differ.

## Licence

[MIT](LICENSE).
