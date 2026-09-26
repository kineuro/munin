// SPDX-License-Identifier: AGPL-3.0-only
// A Keep a Changelog file: every `## [x.y.z] - YYYY-MM-DD` becomes a milestone, its bold headlines the summary.
import { readFileSync } from "node:fs";
import type { ImportedEntry, SourceOutput } from "./types.js";

export interface ChangelogSource {
  kind: "changelog";
  file: string;
  key?: string;
  /** Title template, `{version}` filled in. */
  title?: string;
  url?: string;
  tags?: string[];
}

export function readChangelog(src: ChangelogSource): SourceOutput {
  const prefix = src.key ?? "changelog";
  const text = readFileSync(src.file, "utf8");
  const entries: ImportedEntry[] = [];
  const re = /^## \[([^\]]+)\]\s*-\s*(\d{4}-\d{2}-\d{2})\s*$/gm;
  const heads = [...text.matchAll(re)];
  heads.forEach((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const end = heads[i + 1]?.index ?? text.search(/^\[[^\]]+\]:/m) ?? text.length;
    const section = text.slice(start, end > start ? end : text.length).trim();
    const headlines: string[] = [];
    let group = "";
    const body: string[] = [];
    for (const line of section.split("\n")) {
      const g = /^###\s+(.*)$/.exec(line);
      if (g) {
        group = g[1] as string;
        body.push(`**${group}**`, "");
        continue;
      }
      const b = /^- \*\*(.+?)\*\*(.*)$/.exec(line);
      if (b) {
        const head = (b[1] as string).replace(/[:.]$/, "");
        headlines.push(head);
        const rest = (b[2] as string).replace(/^\s*[\u2014:-]+\s*/, "");
        const first = rest.split(/(?<=\.)\s/)[0] ?? "";
        body.push(`- **${head}**${first ? `: ${first.slice(0, 240)}` : ""}`);
      } else if (/^- /.test(line) && !/^-\s*$/.test(line)) {
        body.push(line.slice(0, 260));
      } else if (!line.trim() && body.at(-1) !== "") {
        body.push("");
      }
    }
    const version = m[1] as string;
    entries.push({
      key: `${prefix}:${version}`,
      type: "milestone",
      title: (src.title ?? "{version}").replace("{version}", version),
      date: m[2] as string,
      summary: headlines.slice(0, 4).join("; "),
      body: body.join("\n").trim(),
      fields: src.url ? { sources: [{ label: "Changelog", url: src.url }] } : {},
      tags: src.tags ?? [],
    });
  });
  // The file lists the newest first; the entries go oldest first, so two versions on one day read in order.
  entries.reverse().sort((a, b) => a.date.localeCompare(b.date));
  return { entries, warnings: [] };
}
