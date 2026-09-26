# Running Munin

Munin is one Node process with one SQLite file. It serves the page, the JSON API under `/api` and the sign-in under `/auth`.

## Try it on a laptop

1. Build it:

```sh
npm ci && npm run build
```

2. Import the made-up demo timeline:

```sh
node dist/main.js import --config munin.dev.json --manifest examples/demo/sources.json
```

3. Serve it, and open http://127.0.0.1:7580:

```sh
node dist/main.js serve --config munin.dev.json
```

`munin.dev.json` uses `dev` sign-in: the page lists made-up people (`ada` is an administrator) and you pick who to be. Dev mode refuses to listen on anything but a loopback address.

## Run it for a group

1. Register Munin at your OpenID Connect provider as a confidential client with the authorization code flow, the redirect URI `https://<your origin>/auth/callback` and the scopes `openid email profile`. The ID token must carry the person's groups in a claim (`groups` by default; Authentik's `profile` scope does this).
2. Put the client secret in a file beside the configuration, readable only by Munin's user:

```sh
mkdir -p data && install -m 600 /dev/null data/client-secret && $EDITOR data/client-secret
```

3. Copy the example configuration and set `origin`, `issuer` and `clientId`:

```sh
cp munin.example.json data/munin.json
```

4. Start the container:

```sh
docker compose up -d --build
```

5. Check it answers:

```sh
curl -s http://127.0.0.1:8080/health
```

6. Put a reverse proxy that terminates TLS for your origin in front of port 8080. Munin does its own sign-in, so the proxy needs no authentication of its own.

> **Warning: the origin must be exact.** Munin builds the redirect URI from `origin` and refuses changing requests whose `Origin` header differs from it, so a proxy on another name or port breaks sign-in and every change.

## Configuration

| Key | Default | What it does |
|---|---|---|
| `listen.host`, `listen.port` | `127.0.0.1`, `8080` | Where the server listens |
| `origin` | `http://127.0.0.1:8080` | The public address, for redirects, cookies and the origin check |
| `db` | `munin.db` | The SQLite file, relative to the configuration |
| `web` | `web` | The folder with the page |
| `sessionDays` | `14` | How long a sign-in lasts |
| `auth.mode` | `dev` | `oidc`, or `dev` on a laptop |
| `auth.issuer`, `auth.clientId`, `auth.clientSecretFile` | | The provider, for `oidc` |
| `auth.groupsClaim` | `groups` | The ID token claim that lists a person's groups |
| `auth.adminGroup` | `admin` | Its members see and manage every timeline |
| `auth.allowGroups` | `[]` | When not empty, only these groups (and admins) may sign in |
| `auth.createGroups` | `"all"` | Who may create timelines: everyone signed in, or a list of groups |
| `auth.devUsers` | three made-up people | The people dev mode offers |

`MUNIN_CONFIG` names the configuration file when `--config` is not given.

## Who sees what

- A timeline belongs to the person who created it. Administrators see and manage every timeline.
- The owner shares it with people, groups or everyone signed in, at one of three levels: **view**, **comment** (which includes viewing) or **edit** (which includes both, and adds and changes entries).
- Only the owner and administrators share, rename, hand on or delete a timeline.
- A timeline you may not see answers "no such timeline", as if it did not exist.
- `munin owner --timeline SLUG --user USERNAME` hands a timeline to someone who has signed in once.

## Importing

An import fills a timeline from sources that already exist, and a later import keeps it fresh. A manifest names the timeline and its sources; paths are relative to the manifest:

```sh
node dist/main.js import --config data/munin.json --manifest sources.json
```

| Kind | Reads | Makes |
|---|---|---|
| `adr` | a folder of numbered decision records, `NN-title.md` | a decision per record, with its ask, rulings, decider and state; a finding per "What was found" section; an open question per "What stays open"; an action for its slices and its merge; links to the records and releases it names |
| `history` | Markdown files whose `## ` sections are dated | an action per section |
| `studies` | a folder of `YYYY-MM-DD-what/` folders | a result per study, from the opening of its README |
| `changelog` | a Keep a Changelog file | a milestone per version |
| `git` | a repository | a milestone for its first commit, actions for when named folders first appeared, and a chart of commits per month |
| `releases` | GitHub releases of one or more repositories (`GITHUB_TOKEN`, or `gh auth token`) | a milestone per tag |
| `entries` | a JSON file of hand-written entries, overrides laid over other sources' entries, extra links, and the big picture | what it says |

`examples/demo/` is a complete made-up example.

The rules an import keeps:
- Every entry has a stable key per source (`record:12`, `release:v1.2.0`), so a second run changes only what changed.
- It never touches a comment.
- An imported entry someone edited in the page is left alone until they choose "Follow the source again".
- An entry whose source is gone is marked, not deleted.
- The big picture it writes stays until someone edits it in the page.
- Anything that looks like a personal identity number, a DICOM UID, an e-mail address, a subject label, a long hash or a path where data lives is replaced before it is stored, and the report counts the replacements.

## Backups

The database is one SQLite file in WAL mode. Copy it with SQLite's own backup, not with `cp`, while Munin runs:

```sh
sqlite3 data/munin.db ".backup data/munin-$(date +%F).db"
```

## Reference: the API

Every door but `/health` and `/api/me` needs a session. Changing doors need `Content-Type: application/json` and `X-Munin: 1`.

| Door | What |
|---|---|
| `GET /api/me` | Who is signed in, and the sign-in mode |
| `GET /api/timelines`, `POST /api/timelines` | The timelines you may see; create one |
| `GET`, `PATCH`, `DELETE /api/timelines/:slug` | One timeline with its entries and links; change it; delete it |
| `PUT /api/timelines/:slug/grants` | Who may view, comment or edit |
| `GET /api/timelines/:slug/search?q=` | Entries whose text holds the words |
| `POST /api/timelines/:slug/entries` | Add an entry |
| `GET`, `PATCH`, `DELETE /api/entries/:id` | One entry in full; change it; delete it |
| `POST /api/entries/:id/links`, `DELETE /api/links/:id` | Link two entries; unlink |
| `GET`, `POST /api/entries/:id/comments` | The threads on an entry; comment or reply |
| `PATCH`, `DELETE /api/comments/:id` | Edit, resolve or reopen; remove |
| `GET /api/directory` | The people and groups Munin has seen, for sharing and mentions |
