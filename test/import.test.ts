// SPDX-License-Identifier: AGPL-3.0-only
// The importer on a made-up project: two decision records, a changelog, a study and a hand-written file.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DB, openDb } from "../src/db.js";
import { type Manifest, runImport } from "../src/import.js";

let dir: string;
let db: DB;

function fixture(): Manifest {
  mkdirSync(join(dir, "decisions"));
  writeFileSync(
    join(dir, "decisions", "01-the-first.md"),
    '# 01 · The first\n\nOpened 2026-01-05. **Closed**: released in 1.0.0-alpha.2.\n\n## The ask\n\n> Alex, 2026-01-05: "make it fast"\n\n## Rulings\n\n| | Ruling |\n|---|---|\n| R1 | Rust |\n\n## What was found\n\nThe old one was slow at /data/source/cohort/x.\n',
  );
  writeFileSync(
    join(dir, "decisions", "02-the-second.md"),
    "# 02 · The second\n\nOpened 2026-02-01. Follows [01](01-the-first.md).\n\n## The ask\n\nMore.\n\n## What stays open\n\nWho reads it.\n",
  );
  writeFileSync(
    join(dir, "CHANGELOG.md"),
    "# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2025-12-01\n\n### Added\n\n- **Faster** \u2014 much.\n\n## [0.1.0] - 2025-11-01\n\n### Added\n\n- **First**: it runs.\n",
  );
  mkdirSync(join(dir, "studies", "2026-01-10-speed"), { recursive: true });
  writeFileSync(
    join(dir, "studies", "2026-01-10-speed", "README.md"),
    "# Speed, measured\n\nFor record 1. Subject sub-A1B2 was fastest.\n",
  );
  writeFileSync(
    join(dir, "hand.json"),
    JSON.stringify({
      entries: [
        {
          key: "q1",
          type: "question",
          title: "Who pays?",
          date: "2026-02-02",
          status: "open",
          fields: { waitingOn: "Alex" },
        },
      ],
      overrides: { "record:2": { fields: { decidedBy: "Alex" } } },
      links: [{ from: "hand:q1", to: "record:2", kind: "relates" }],
      picture: { now: "Going", next: "More", waiting: "Alex" },
    }),
  );
  return {
    timeline: { slug: "demo", title: "Demo" },
    sources: [
      { kind: "changelog", file: join(dir, "CHANGELOG.md"), key: "v0", title: "v0 {version}" },
      { kind: "adr", dir: join(dir, "decisions"), deciders: ["Alex"], releaseKey: "release" },
      { kind: "studies", dir: join(dir, "studies"), recordKey: "record" },
      { kind: "entries", file: join(dir, "hand.json") },
    ],
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "munin-import-"));
  db = openDb(join(dir, "m.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("import", () => {
  it("makes typed entries with stable keys, links and a picture", async () => {
    const r = await runImport(db, fixture());
    expect(r.byType).toEqual({ milestone: 2, decision: 2, finding: 1, question: 2, result: 1 });
    expect(r.created).toBe(8);
    const keys = (
      db.prepare("SELECT source_key FROM entries ORDER BY source_key").all() as { source_key: string }[]
    ).map((x) => x.source_key);
    expect(keys).toEqual([
      "hand:q1",
      "record:1",
      "record:1:found",
      "record:2",
      "record:2:open",
      "study:2026-01-10-speed",
      "v0:0.1.0",
      "v0:0.2.0",
    ]);
    const d1 = db.prepare("SELECT date, fields_json FROM entries WHERE source_key = 'record:1'").get() as {
      date: string;
      fields_json: string;
    };
    expect(d1.date).toBe("2026-01-05");
    expect(JSON.parse(d1.fields_json)).toMatchObject({ decidedBy: "Alex", state: "done" });
    const d2 = JSON.parse(
      (
        db.prepare("SELECT fields_json FROM entries WHERE source_key = 'record:2'").get() as {
          fields_json: string;
        }
      ).fields_json,
    );
    expect(d2.decidedBy).toBe("Alex");
    // 01 led to 02, the finding led to 01, the study led to 01, the question relates to 02
    const links = db
      .prepare(
        "SELECT a.source_key f, b.source_key t, kind FROM links JOIN entries a ON a.id = from_id JOIN entries b ON b.id = to_id ORDER BY f, t",
      )
      .all();
    expect(links).toContainEqual({ f: "record:1", t: "record:2", kind: "led_to" });
    expect(links).toContainEqual({ f: "record:1:found", t: "record:1", kind: "led_to" });
    expect(links).toContainEqual({ f: "study:2026-01-10-speed", t: "record:1", kind: "led_to" });
    expect(links).toContainEqual({ f: "hand:q1", t: "record:2", kind: "relates" });
    expect(r.unresolved).toEqual(["record:1 -> release:v1.0.0-alpha.2"]);
    const t = db.prepare("SELECT now_md FROM timelines WHERE slug = 'demo'").get() as { now_md: string };
    expect(t.now_md).toBe("Going");
  });

  it("drops what looks like an identifier or a data path", async () => {
    const r = await runImport(db, fixture());
    expect(r.redactions).toBe(4); // each appears in a summary and a body
    const all = (
      db.prepare("SELECT body_md || summary || fields_json AS t FROM entries").all() as { t: string }[]
    )
      .map((x) => x.t)
      .join("\n");
    expect(all).not.toContain("/data/source");
    expect(all).not.toContain("A1B2");
  });

  it("is idempotent, keeps hand edits and comments, and marks what left its source", async () => {
    const m = fixture();
    await runImport(db, m);
    const again = await runImport(db, m);
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 8, stale: 0 });

    const id = (k: string) =>
      (db.prepare("SELECT id FROM entries WHERE source_key = ?").get(k) as { id: number }).id;
    db.prepare("UPDATE entries SET title = 'Mine', by_hand = 1 WHERE id = ?").run(id("record:1"));
    db.prepare("INSERT INTO users (sub, username, created_at, last_seen) VALUES ('s', 'u', 'x', 'x')").run();
    db.prepare(
      "INSERT INTO comments (entry_id, author_id, body_md, created_at) VALUES (?, 1, 'keep me', 'x')",
    ).run(id("record:2"));
    rmSync(join(dir, "studies", "2026-01-10-speed"), { recursive: true });
    writeFileSync(
      join(dir, "decisions", "02-the-second.md"),
      "# 02 · The second, renamed\n\nOpened 2026-02-01.\n\n## The ask\n\nMore.\n",
    );

    const third = await runImport(db, m);
    expect(third).toMatchObject({ kept: 1, stale: 2 });
    expect(
      (db.prepare("SELECT title FROM entries WHERE source_key = 'record:1'").get() as { title: string })
        .title,
    ).toBe("Mine");
    expect(
      (db.prepare("SELECT title FROM entries WHERE source_key = 'record:2'").get() as { title: string })
        .title,
    ).toBe("02 · The second, renamed");
    expect(
      (db.prepare("SELECT COUNT(*) n FROM comments WHERE body_md = 'keep me'").get() as { n: number }).n,
    ).toBe(1);
    expect(
      (
        db.prepare("SELECT stale FROM entries WHERE source_key = 'study:2026-01-10-speed'").get() as {
          stale: number;
        }
      ).stale,
    ).toBe(1);
  });
});
