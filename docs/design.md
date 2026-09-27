# Munin: the design

Munin is one of Odin's two ravens, the one whose name means memory. It keeps a project's memory: where it started, what we decided and why, what we did and what it gave. The mark is the rune ᛗ, drawn in one line on a plum square like the marks of NILS and Bifrost.

## Why

A research project leaves its decisions in many places: decision records, release notes, study folders, chat, a repository's history. Each is right and none of them reads as a story. I wanted one page per project that a group can scroll from the first commit to today, see each decision with the question it answered and who made it, see what was built and measured because of it, and discuss any of it in place.

## What a timeline holds

A timeline is a vertical line of typed entries, newest first and grouped by week. The page opens on the latest week and loads older weeks as you scroll, so a long project opens as fast as a new one; filters are applied by the server, and a link to an old entry loads down to it:

| Type | What it carries |
|---|---|
| Decision | the question, what was chosen, why, who decided, the alternatives, its state |
| Action | what was built or done, with its pull requests and releases |
| Result | numbers, aggregates only, and a small chart |
| Finding | what went wrong or surprised us, and what it taught |
| Milestone | a release, a start, a turn in the road |
| Open question | what is not settled, and whom it waits on |

Entries link to each other: this finding led to that decision, this release answers that record, this record supersedes that one. The page shows each link from both ends ("Led to", "Came from").

Above the line sits the big picture: where we are, what is next, and what waits on whom, with every open question listed under it. It opens folded to its first lines, because it is long and read once a visit; the page remembers in the browser when someone unfolds it.

Every entry has threads. Opening an entry (a click or tap anywhere on it, or Enter on its title) makes it the active one, and its threads show as a chat beside the line on a wide screen, or under the entry on a phone, with the box to write at the bottom. A comment can be answered, and a thread is resolved or reopened at its first comment. Mentions (`@username`) are recorded now so that notifications can be added later without a migration.

## Who sees what

Any signed-in person may create a timeline (a site can restrict this to groups). The owner shares it with people, groups or everyone signed in, at view, comment or edit. Administrators, the members of one group of the identity provider, see and manage everything. A timeline you may not see answers as if it did not exist.

I kept the levels to three and made each include the one below, because every finer scheme I sketched needed a table to explain it.

## Where the content comes from

Most of a project's timeline already exists, so Munin imports it, and a later import keeps it fresh. The importer reads decision records, dated history, study folders, a changelog, a repository's history, GitHub releases and a hand-written JSON file, and gives every entry a stable key per source.

Three rules make importing safe to repeat:
- It never touches comments, and a comment's entry is never deleted by an import. An entry whose source is gone is marked instead.
- An imported entry someone edited in the page belongs to them until they hand it back.
- Anything that looks like a person's identifier or a data path is replaced before it is stored. Munin is for decisions, counts and links; it is not a place for data about people, and the importer enforces that rather than trusting every source to.

## How it is built

- **One process, one file.** A Node server (TypeScript, Hono) with SQLite through better-sqlite3, like Bifrost's server. A group's timelines are thousands of rows, not millions, so a database server would be cost without benefit.
- **The page has no framework and no build step.** It is one ES module that builds DOM nodes. The server renders Markdown to HTML itself, escaping every character before it adds a tag, so the page never turns text into markup.
- **Sign-in is the identity provider's.** OpenID Connect with the authorization code flow and PKCE; Munin keeps its own session as a random token whose hash is stored. There is no password in Munin, and no forward-auth in front of it.
- **Changing doors defend themselves**: JSON only, a custom header, and an origin check, on top of a same-site cookie and a strict Content Security Policy.
- **The look is the group's:** plum on a warm ground, IBM Plex, rules instead of shadows, light and dark themes that follow the system unless a person chooses, and a layout that works from a phone up. Entry types have a colour from a set checked for colour-blind separation, and each also has its own shape and name, so colour is never the only cue.

## What I left out, on purpose

- **Notifications.** Mentions are stored; sending them waits until we know which channel people read.
- **Editing history of entries.** Imports are repeatable and comments are kept, which covers what history would be used for today.
- **Attachments.** An entry links to where things live. Files, and above all data, stay where they are.
