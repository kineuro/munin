# Contributing

Munin is developed in the open. Issues, questions and pull requests are welcome.

## Before you start

- Open an issue before a large change, so the direction is agreed before the code exists. The design is in [docs/design.md](docs/design.md).
- Never put personal or clinical data in an issue, a pull request, a test or a fixture: no patient names, identifiers, UIDs, or folder paths from a clinical system. The fixtures are made up, and so are the examples.

## How work flows

- `main` is protected. Code lands by pull request with a green CI run, rebased onto `main`.
- Commit messages say what changed and why, in prose.
- Every source file starts with an SPDX header, `// SPDX-License-Identifier: AGPL-3.0-only`.
- `npm run check` (types and lint), `npm test` and `npm run build` are what CI runs.

## Licensing your contribution

Everything here is [AGPL-3.0-only](LICENSE). A contribution needs the [contributor license agreement](CLA.md), signed once; a Developer Certificate of Origin sign-off (`git commit -s`) is welcome beside it. On your first pull request a bot asks for the agreement; sign by posting this comment on the pull request:

```text
I have read the CLA Document and I hereby sign the CLA
```
