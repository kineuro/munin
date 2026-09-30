# Changelog

## Unreleased

- A timeline reads newest first, grouped by week: it opens on the latest week and loads older weeks on scroll, with filters applied by the server and links to older entries loading down to them.
- The big picture opens folded to its first lines; unfolding it is remembered in the browser.
- A click or tap anywhere on an entry opens it, not only its title.
- The active entry's threads show as chat bubbles in a pane beside the timeline (under the entry on a phone), replies indented, the box to write at the bottom.
- An import manifest can carry redact rules of its own (`redact`, inline or a JSON file beside it): a pattern and its replacement, run after the built-in ones and counted per rule in the report.

## 0.1.0

- Timelines of typed entries (decision, action, result, finding, milestone, open question), links between them, and a big picture of where a project is, what is next and what waits.
- Threads on every entry: replies, resolve and reopen, mentions.
- Sharing per timeline with people, groups or everyone signed in, at view, comment or edit; administrators see everything.
- Sign-in with OpenID Connect, and a dev mode for a laptop.
- An idempotent importer: decision records, narrative history, studies, a changelog, git history, GitHub releases and a hand-written file.
