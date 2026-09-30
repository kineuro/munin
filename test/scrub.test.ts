// SPDX-License-Identifier: AGPL-3.0-only
// Every identifier here is made up.
import { describe, expect, it } from "vitest";
import { compileRules, scrub, scrubDeep } from "../src/scrub.js";

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

  it("runs a manifest's own rules after the built-in ones, and counts them per rule", () => {
    const extra = compileRules([
      { name: "machine", pattern: "\\b(?:alpha|beta)-box\\b", flags: "i", to: "a machine" },
      { name: "tool", pattern: "\\bToolX\\b", to: "tool-1" },
    ]);
    const r = scrub("ran on Alpha-box and beta-box with ToolX, see /data/x", extra);
    expect(r.text).toBe("ran on a machine and a machine with tool-1, see [path]");
    expect(r.byRule).toEqual({ "data path": 1, machine: 2, tool: 1 });
  });

  it("leaves links alone and adds up across a value", () => {
    const extra = compileRules([{ name: "tool", pattern: "ToolX", to: "tool-1" }]);
    const counter = { n: 0, byRule: {} as Record<string, number> };
    const v = scrubDeep({ a: "ToolX", b: ["ToolX"], url: "https://example.org/ToolX" }, counter, extra);
    expect(v).toEqual({ a: "tool-1", b: ["tool-1"], url: "https://example.org/ToolX" });
    expect(counter).toEqual({ n: 2, byRule: { tool: 2 } });
  });

  it("refuses a rule it cannot use, by name", () => {
    expect(() => compileRules([{ name: "bad", pattern: "(", to: "x" }])).toThrow(/redact bad/);
    expect(() => compileRules([{ name: "flags", pattern: "x", flags: "q", to: "x" }])).toThrow(
      /unknown flags/,
    );
    expect(() => compileRules([{ pattern: "", to: "x" }])).toThrow(/redact rule 1/);
  });
});
