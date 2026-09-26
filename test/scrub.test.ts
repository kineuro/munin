// SPDX-License-Identifier: AGPL-3.0-only
// Every identifier here is made up.
import { describe, expect, it } from "vitest";
import { scrub } from "../src/scrub.js";

describe("scrub", () => {
  it("replaces personal numbers, UIDs, e-mail, subject labels and long hashes", () => {
    const r = scrub(
      "pn 19121212-1212 and 201212121212, uid 1.2.826.0.1.3680043.2.1125, mail a.b@example.org, sub-X12Y, code 9f86d081884c7d659a2feaa0c55ad015",
    );
    expect(r.text).toBe("pn [id] and [id], uid [uid], mail [email], sub-[id], code [hash]");
    expect(r.redactions).toBe(6);
  });

  it("replaces paths where data lives, and home folders", () => {
    const r = scrub("in /data/source/study/x and /media/disk/a, `~/work/reg`, /home/someone/file");
    expect(r.text).toBe("in [path] and [path], `[path]`, [path]");
  });

  it("leaves dates, versions, addresses, doors and code paths alone", () => {
    const t =
      "2026-09-24, 1.0.0-alpha.47, 10.0.0.1, /api/health, web/src/data/tags.ts, commit 2d7c374, sub-<label>";
    expect(scrub(t).text).toBe(t);
  });
});
