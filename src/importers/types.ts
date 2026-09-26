// SPDX-License-Identifier: AGPL-3.0-only
// What every importer produces: entries with a stable key per source, and links between keys.
import type { EntryType, LinkKind } from "../db.js";

export interface Metric {
  label: string;
  value: string | number;
  unit?: string;
  note?: string;
}

export interface Chart {
  title: string;
  unit?: string;
  bars: { label: string; value: number }[];
}

export interface Fields {
  /** Decision: what had to be decided. */
  question?: string;
  /** Decision: what was chosen. */
  choice?: string;
  why?: string;
  decidedBy?: string;
  alternatives?: string[];
  /** Where the entry comes from, and anything to read. */
  sources?: { label: string; url?: string }[];
  /** Action and milestone: pull requests, releases, studies. */
  links?: { label: string; url: string }[];
  /** Result: numbers, aggregates only. */
  metrics?: Metric[];
  chart?: Chart;
  /** Finding: what it taught. */
  lesson?: string;
  /** Open question: who it waits on. */
  waitingOn?: string;
  /** Decision: in force, done, retired, deferred. */
  state?: string;
}

export interface ImportedEntry {
  key: string;
  type: EntryType;
  title: string;
  /** YYYY-MM-DD */
  date: string;
  summary?: string;
  body?: string;
  fields?: Fields;
  tags?: string[];
  status?: "" | "open" | "closed";
  links?: { to: string; kind: LinkKind; reverse?: boolean }[];
}

export interface Picture {
  now?: string;
  next?: string;
  waiting?: string;
}

export interface ExtraLink {
  from: string;
  to: string;
  kind: LinkKind;
}

export interface SourceOutput {
  entries: ImportedEntry[];
  /** Links between entries of any source, by key. */
  links?: ExtraLink[];
  overrides?: Record<string, Partial<ImportedEntry>>;
  picture?: Picture;
  warnings: string[];
}

export const ISO = /\b(20\d{2}-\d{2}-\d{2})\b/;

export function firstDate(text: string): string | undefined {
  return ISO.exec(text)?.[1];
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);
}

/** The first sentences of a Markdown paragraph, plain, cut near `max` characters. */
export function brief(md: string, max = 280): string {
  const plain = md
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^\s*[>#|-]+\s?/gm, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return stop > max * 0.4 ? cut.slice(0, stop + 1) : `${cut.replace(/\s+\S*$/, "")} ...`;
}

/** Record numbers a text mentions: "record 40", "records 35, 37 and 38", "[40](40-...md)". */
export function recordRefs(text: string): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(/\brecords?\s+((?:\d{1,2}(?:\s*(?:,|and|to|&)\s*)?)+)/gi)) {
    const list = m[1] as string;
    const range = /(\d{1,2})\s*to\s*(\d{1,2})/.exec(list);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (b > a && b - a < 30) for (let n = a; n <= b; n++) out.add(n);
    }
    for (const n of list.matchAll(/\d{1,2}/g)) out.add(Number(n[0]));
  }
  for (const m of text.matchAll(/\[(\d{1,2})\]\((\d{2})-[^)]*\.md[^)]*\)/g)) out.add(Number(m[1]));
  return [...out].sort((a, b) => a - b);
}

/** Splits Markdown into its `## ` sections: a preamble (before the first) and the rest, in order. */
export function sections(md: string): {
  title: string;
  h1: string;
  preamble: string;
  parts: { heading: string; body: string }[];
} {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  let h1 = "";
  const pre: string[] = [];
  const parts: { heading: string; body: string }[] = [];
  let cur: { heading: string; lines: string[] } | null = null;
  let fenced = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && !h1 && /^#\s+/.test(line) && !cur) {
      h1 = line.replace(/^#\s+/, "").trim();
      continue;
    }
    if (!fenced && /^##\s+/.test(line)) {
      if (cur) parts.push({ heading: cur.heading, body: cur.lines.join("\n").trim() });
      cur = { heading: line.replace(/^##\s+/, "").trim(), lines: [] };
      continue;
    }
    (cur ? cur.lines : pre).push(line);
  }
  if (cur) parts.push({ heading: cur.heading, body: cur.lines.join("\n").trim() });
  return { title: h1, h1, preamble: pre.join("\n").trim(), parts };
}

/** Stockholm's calendar date of an instant, so a release at 23:30 local time lands on its own day. */
export function localDate(iso: string, timeZone = "Europe/Stockholm"): string {
  const d = new Date(iso);
  const f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return f.format(d);
}
