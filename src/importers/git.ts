// SPDX-License-Identifier: AGPL-3.0-only
// A git repository's own history: when it started, when named parts of it first appeared, and how busy each month
// was. Commit counts only; no message, author or file name is copied.
import { execFileSync } from "node:child_process";
import type { EntryType } from "../db.js";
import type { ImportedEntry, SourceOutput } from "./types.js";

export interface GitSource {
  kind: "git";
  repo: string;
  key: string;
  start?: { title: string; summary?: string; type?: EntryType };
  paths?: { path: string; title: string; summary?: string; type?: EntryType }[];
  /** A result with commits per month, as a chart. */
  monthly?: { title: string; summary?: string; until?: string };
  tags?: string[];
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

export function readGit(src: GitSource): SourceOutput {
  const entries: ImportedEntry[] = [];
  const warnings: string[] = [];
  const tags = src.tags ?? [];
  if (src.start) {
    const first = git(src.repo, ["log", "--reverse", "--format=%ad", "--date=short"]).split("\n")[0];
    if (first)
      entries.push({
        key: `${src.key}:start`,
        type: src.start.type ?? "milestone",
        title: src.start.title,
        date: first,
        summary: src.start.summary ?? "",
        tags,
      });
  }
  for (const p of src.paths ?? []) {
    const first = git(src.repo, ["log", "--reverse", "--format=%ad", "--date=short", "--", p.path]).split(
      "\n",
    )[0];
    if (!first) {
      warnings.push(`${p.path}: no commit touches it`);
      continue;
    }
    entries.push({
      key: `${src.key}:path:${p.path}`,
      type: p.type ?? "action",
      title: p.title,
      date: first,
      summary: p.summary ?? "",
      tags,
    });
  }
  if (src.monthly) {
    const months = new Map<string, number>();
    for (const d of git(src.repo, ["log", "--format=%ad", "--date=format:%Y-%m"]).split("\n")) {
      if (d && (!src.monthly.until || d <= src.monthly.until)) months.set(d, (months.get(d) ?? 0) + 1);
    }
    const keys = [...months.keys()].sort();
    if (keys.length) {
      const bars: { label: string; value: number }[] = [];
      const [y0, m0] = (keys[0] as string).split("-").map(Number) as [number, number];
      const [y1, m1] = (keys.at(-1) as string).split("-").map(Number) as [number, number];
      for (let y = y0, m = m0; y < y1 || (y === y1 && m <= m1); m === 12 ? (y++, (m = 1)) : m++) {
        const k = `${y}-${String(m).padStart(2, "0")}`;
        bars.push({ label: k, value: months.get(k) ?? 0 });
      }
      const total = bars.reduce((a, b) => a + b.value, 0);
      const last = git(src.repo, ["log", "-1", "--format=%ad", "--date=short"]).trim();
      entries.push({
        key: `${src.key}:monthly`,
        type: "result",
        title: src.monthly.title,
        date: last,
        summary: src.monthly.summary ?? `${total} commits from ${keys[0]} to ${keys.at(-1)}.`,
        fields: {
          metrics: [
            { label: "Commits", value: total },
            { label: "Months", value: bars.length },
          ],
          chart: { title: "Commits per month", bars },
        },
        tags,
      });
    }
  }
  return { entries, warnings };
}
