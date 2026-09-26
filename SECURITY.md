# Security

Munin keeps what a group decided, discussed and measured, and who may see it, so reports are taken seriously.

**Report a vulnerability** to admin@kineuro.se, or through "Report a vulnerability" under this repository's Security tab. Please do not open a public issue for it. We answer within a week, fix confirmed issues as fast as we can, and credit you in the release notes if you wish.

**What it protects:**
- Every door checks the person's access to the timeline first, and a timeline you may not see answers as if it did not exist.
- Sessions are random tokens; only their SHA-256 is stored. Munin never holds a password: people sign in at an OpenID Connect provider with the authorization code flow and PKCE.
- Changing doors want JSON, a custom header and a same-site origin, so a form on another site cannot use them.
- Text is Markdown rendered on the server with every character escaped before any tag is added, and the page runs under a strict Content Security Policy.
- The importer replaces anything that looks like a personal identifier or a data path before it is stored.

**Out of scope:** the operating system, reverse proxy and identity provider you run Munin behind.
