// SPDX-License-Identifier: AGPL-3.0-only
// Narrative history files: every `## ` section is one thing that was done, dated by the first date in its heading
// (or its text), and linked to the records and releases it names.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { EntryType } from "../db.js";
import {
  brief,
  firstDate,
  type ImportedEntry,
  recordRefs,
  type SourceOutput,
  sections,
  slugify,
} from "./types.js";

export interface HistorySource {
  kind: "history";
  files: string[];
  key?: string;
  type?: EntryType;
  recordKey?: string;
  releaseKey?: string;
  releaseTag?: string;
  webBase?: string;
  tags?: string[];
}

export function readHistory(src: HistorySource): SourceOutput {
  const prefix = src.key ?? "history";
  const entries: ImportedEntry[] = [];
  const warnings: string[] = [];
  for (const file of src.files) {
    const s = sections(readFileSync(file, "utf8"));
    const base = basename(file, ".md");
    let lastDate: string | undefined;
    for (const p of s.parts) {
      const date = firstDate(p.heading) ?? firstDate(p.body) ?? lastDate;
      if (!date) {
        warnings.push(`${base}: "${p.heading}" has no date, skipped`);
        continue;
      }
      lastDate = date;
      const title = p.heading.replace(/\s*\([^)]*\d{4}-\d{2}-\d{2}[^)]*\)\s*$/, "").trim();
      const links: NonNullable<ImportedEntry["links"]> = [];
      if (src.recordKey) {
        const inHead = recordRefs(p.heading);
        for (const n of inHead) links.push({ to: `${src.recordKey}:${n}`, kind: "led_to", reverse: true });
        for (const n of recordRefs(p.body)) {
          if (!inHead.includes(n)) links.push({ to: `${src.recordKey}:${n}`, kind: "relates" });
        }
      }
      if (src.releaseKey) {
        const tags = new Set<string>();
        for (const m of p.heading.matchAll(/\balpha\.(\d+)/g)) tags.add(m[1] as string);
        for (const t of tags)
          links.push({ to: `${src.releaseKey}:${src.releaseTag ?? "v1.0.0-alpha."}${t}`, kind: "led_to" });
      }
      entries.push({
        key: `${prefix}:${base}:${slugify(title)}`,
        type: src.type ?? "action",
        title,
        date,
        summary: brief(p.body, 320),
        body: p.body,
        fields: src.webBase
          ? { sources: [{ label: base, url: `${src.webBase.replace(/\/$/, "")}/${base}.md` }] }
          : {},
        tags: src.tags ?? [],
        links,
      });
    }
  }
  return { entries, warnings };
}
