// SPDX-License-Identifier: AGPL-3.0-only
// A folder of studies, one folder each, named `YYYY-MM-DD-what`. The first of README, study, report or results is
// read: its heading is the title, its opening paragraph the summary. Only the opening is taken, never the tables of
// a study's data.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { EntryType } from "../db.js";
import { brief, firstDate, type ImportedEntry, recordRefs, type SourceOutput, sections } from "./types.js";

export interface StudiesSource {
  kind: "studies";
  dir: string;
  key?: string;
  type?: EntryType;
  recordKey?: string;
  webBase?: string;
  /** Folder names to leave out. */
  skip?: string[];
  tags?: string[];
}

const NAMES = ["README.md", "study.md", "report.md", "REPORT.md", "results.md", "RESULTS.md", "findings.md"];

export function readStudies(src: StudiesSource): SourceOutput {
  const prefix = src.key ?? "study";
  const entries: ImportedEntry[] = [];
  const warnings: string[] = [];
  for (const name of readdirSync(src.dir).sort()) {
    const dir = join(src.dir, name);
    if (!statSync(dir).isDirectory() || src.skip?.includes(name)) continue;
    const file = NAMES.map((n) => join(dir, n)).find((p) => existsSync(p));
    if (!file) {
      warnings.push(`${name}: no README, study, report or results file`);
      continue;
    }
    const s = sections(readFileSync(file, "utf8"));
    const date = /^(\d{4}-\d{2}-\d{2})/.exec(name)?.[1] ?? firstDate(s.preamble);
    if (!date) {
      warnings.push(`${name}: no date in the folder name or the opening`);
      continue;
    }
    const paras = s.preamble
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p && !/^(\||```)/.test(p));
    const opening = paras.slice(0, 3).join("\n\n");
    const title = (s.h1 || name).replace(/,?\s*\(?20\d{2}-\d{2}-\d{2}\)?\s*$/, "").trim();
    const links: NonNullable<ImportedEntry["links"]> = [];
    if (src.recordKey) {
      for (const n of recordRefs(`${s.h1}\n${opening}`))
        links.push({ to: `${src.recordKey}:${n}`, kind: "led_to" });
    }
    entries.push({
      key: `${prefix}:${name}`,
      type: src.type ?? "result",
      title,
      date,
      summary: brief(paras.find((p) => !p.startsWith(">")) ?? opening, 320),
      body: opening,
      fields: src.webBase
        ? { sources: [{ label: `Study ${name}`, url: `${src.webBase.replace(/\/$/, "")}/${name}` }] }
        : {},
      tags: src.tags ?? [],
      links,
    });
  }
  return { entries, warnings };
}
