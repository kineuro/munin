// SPDX-License-Identifier: AGPL-3.0-only
// A folder of numbered decision records (`NN-title.md`), one Markdown file per record, as architecture decision
// records are usually kept. Each record becomes a decision, and its findings, its slices, its merge and its open
// questions become entries of their own, linked to it.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { LinkKind } from "../db.js";
import { brief, firstDate, type ImportedEntry, recordRefs, type SourceOutput, sections } from "./types.js";

export interface AdrSource {
  kind: "adr";
  dir: string;
  /** Key prefix, default `record`. */
  key?: string;
  /** Link base for each file, such as https://github.com/org/repo/blob/main/decisions */
  webBase?: string;
  /** The people who decide, found by name where a record quotes them. */
  deciders?: string[];
  /** Records up to this number were ratified together; `by` says who decided them and when. */
  ratified?: { upTo: number; by: string };
  /** The key prefix of release milestones, to link "released in alpha.N". */
  releaseKey?: string;
  releaseTag?: string;
  tags?: string[];
}

const ASK = /^(\d+\.\s*)?the asks?\b/i;
const RULINGS =
  /^(\d+\.\s*)?(the )?(rulings|settled|nima's decisions|nima's rulings|decisions taken on that|what the second round settled|decisions)\b/i;
const WHY = /^(\d+\.\s*)?why\b/i;
const FOUND =
  /^(\d+\.\s*)?(what (was|the [\w\s-]+?) (found|finds|says|said|measured)|what went wrong|what is wrong|what the [\w\s-]+ found, and why|found (while|after) [\w\s]+)/i;
const OPEN = /(stays open|does not settle|left open|still open|open questions)/i;
const SLICES = /^(\d+\.\s*)?(slices|the wave|the slices)\b/i;

function gitFirstDate(file: string): string | undefined {
  try {
    const out = execFileSync(
      "git",
      [
        "-C",
        dirname(file),
        "log",
        "--diff-filter=A",
        "--follow",
        "--format=%ad",
        "--date=short",
        "--",
        basename(file),
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return out.trim().split("\n").pop() || undefined;
  } catch {
    return undefined;
  }
}

function quotes(md: string): string[] {
  return md
    .split(/\n\s*\n/)
    .filter((p) => /^\s*>/.test(p))
    .map((p) => p.replace(/^\s*>\s?/gm, "").trim());
}

export function readAdr(src: AdrSource): SourceOutput {
  const prefix = src.key ?? "record";
  const warnings: string[] = [];
  const entries: ImportedEntry[] = [];
  const files = readdirSync(src.dir)
    .filter((f) => /^\d{2,3}-.*\.md$/.test(f))
    .sort();
  for (const f of files) {
    const path = join(src.dir, f);
    const n = Number(f.slice(0, f.indexOf("-")));
    const md = readFileSync(path, "utf8");
    const s = sections(md);
    const title =
      s.h1
        .replace(/^\d+\s*[\u00b7.:\u2014\u2013-]+\s*/, "")
        .replace(/\s*\(20\d{2}-\d{2}-\d{2}\)\s*$/, "")
        .trim() || f;
    const head = `${s.h1}\n${s.preamble}`;
    const date =
      /\b(?:Opened|Written|Run|Measured)\s+(?:on\s+)?(20\d{2}-\d{2}-\d{2})/.exec(head)?.[1] ??
      firstDate(s.h1) ??
      firstDate(s.preamble.split("\n").slice(0, 6).join("\n")) ??
      gitFirstDate(path);
    if (!date) {
      warnings.push(`${f}: no date found, skipped`);
      continue;
    }
    const key = `${prefix}:${n}`;
    const url = src.webBase ? `${src.webBase.replace(/\/$/, "")}/${f}` : undefined;
    const ask = s.parts.filter((p) => ASK.test(p.heading));
    const rulings = s.parts.filter((p) => RULINGS.test(p.heading) && !ASK.test(p.heading));
    const why = s.parts.find((p) => WHY.test(p.heading));
    const found = s.parts.filter((p) => FOUND.test(p.heading));
    const open = s.parts.filter((p) => OPEN.test(p.heading));
    const slices = s.parts.find((p) => SLICES.test(p.heading));

    const askText = ask.map((p) => p.body).join("\n\n");
    const choiceText = rulings
      .map((p) => (rulings.length > 1 ? `**${p.heading}**\n\n${p.body}` : p.body))
      .join("\n\n");
    const state = stateOf(s.preamble);
    const links: ImportedEntry["links"] = [];

    // Who decided: a decider quoted in the ask or the rulings, or the ratification that covers early records.
    const deciders = (src.deciders ?? []).filter((d) =>
      new RegExp(`\\b${d}\\b`).test(`${askText}\n${choiceText}\n${s.preamble}`),
    );
    let decidedBy = deciders.join(" and ");
    if (src.ratified && n <= src.ratified.upTo && !decidedBy) decidedBy = src.ratified.by;

    // Links from the preamble: what this follows, what it retired into, what it amends.
    for (const sentence of s.preamble.split(/(?<=[.!?])\s+/)) {
      const refs = recordRefs(sentence).filter((r) => r !== n);
      const into = /\bretired\b.*?\binto\s+\[?(\d{1,2})/i.exec(sentence)?.[1];
      for (const r of refs) {
        if (into) {
          if (Number(into) === r) links.push({ to: `${prefix}:${r}`, kind: "supersedes", reverse: true });
          else links.push({ to: `${prefix}:${r}`, kind: "relates" });
        } else if (/\b(follows|out of|after|from)\b/i.test(sentence))
          links.push({ to: `${prefix}:${r}`, kind: "led_to", reverse: true });
        else if (/\bamends?\b/i.test(sentence)) links.push({ to: `${prefix}:${r}`, kind: "supersedes" });
        else links.push({ to: `${prefix}:${r}`, kind: "relates" });
      }
    }
    if (src.releaseKey) {
      for (const m of s.preamble.matchAll(/\breleased (?:in|as) (?:(?:1\.0\.0-)?alpha\.(\d+))/gi)) {
        links.push({ to: `${src.releaseKey}:${src.releaseTag ?? "v1.0.0-alpha."}${m[1]}`, kind: "led_to" });
      }
    }

    const q = quotes(askText);
    const summary =
      brief(q[0] ?? askText ?? "", 320) || brief(firstParagraph(s.preamble) || firstBody(s.parts), 320);
    const bodyParts = [s.preamble.trim()];
    if (askText) bodyParts.push(`#### The ask\n\n${askText}`);
    if (!askText && !choiceText) bodyParts.push(firstBody(s.parts));
    entries.push({
      key,
      type: "decision",
      title: `${pad(n)} · ${title}`,
      date,
      summary,
      body: bodyParts.filter(Boolean).join("\n\n"),
      fields: {
        question: askText
          ? brief(q[0] ?? askText, 600)
          : brief(firstParagraph(s.preamble) || firstBody(s.parts), 600),
        choice: choiceText || undefined,
        why: why?.body,
        decidedBy: decidedBy || undefined,
        state,
        sources: [{ label: `Record ${pad(n)}`, ...(url ? { url } : {}) }],
      },
      tags: [...(src.tags ?? []), `record ${n}`],
      links: dedupe(links),
    });

    found.forEach((p, i) => {
      entries.push({
        key: `${key}:found${i ? `:${i + 1}` : ""}`,
        type: "finding",
        title: `${pad(n)} · ${p.heading.replace(/^\d+\.\s*/, "")}`,
        date,
        summary: brief(firstParagraph(p.body) || p.body, 320),
        body: p.body,
        fields: { sources: [{ label: `Record ${pad(n)}`, ...(url ? { url } : {}) }] },
        tags: [...(src.tags ?? []), `record ${n}`],
        links: [{ to: key, kind: "led_to" }],
      });
    });

    open.forEach((p, i) => {
      const closed = state === "done" || state === "retired";
      entries.push({
        key: `${key}:open${i ? `:${i + 1}` : ""}`,
        type: "question",
        title: `${pad(n)} · ${p.heading.replace(/^\d+\.\s*/, "")}`,
        date,
        summary: brief(firstParagraph(p.body) || p.body, 320),
        body: p.body,
        status: closed ? "closed" : "open",
        fields: { sources: [{ label: `Record ${pad(n)}`, ...(url ? { url } : {}) }] },
        tags: [...(src.tags ?? []), `record ${n}`],
        links: [{ to: key, kind: "relates", reverse: true }],
      });
    });

    if (slices) {
      const count = (slices.body.match(/^\|\s*[A-Z]?\d+[a-z]?\s*\|/gm) ?? []).length;
      entries.push({
        key: `${key}:slices`,
        type: "action",
        title: `${pad(n)} · ${count ? `${count} slices planned` : "The slices"}`,
        date,
        summary: sliceSummary(slices.body),
        body: slices.body,
        fields: { sources: [{ label: `Record ${pad(n)}`, ...(url ? { url } : {}) }] },
        tags: [...(src.tags ?? []), `record ${n}`],
        links: [{ to: key, kind: "led_to", reverse: true }],
      });
    }

    const merged =
      /\*\*Merged(?: (?:on )?)?(20\d{2}-\d{2}-\d{2})?\*\*([^\n]*)/.exec(s.preamble) ??
      /\b[Mm]erged (20\d{2}-\d{2}-\d{2})\*{0,2}\s*(?:as\s+)?([^\n]*)/.exec(s.preamble);
    if (merged) {
      const line = `${merged[1] ?? ""} ${merged[2] ?? ""}`;
      const prs = [...line.matchAll(/kineuro\/([\w.-]+)#(\d+)|\b(nils(?:-desk)?|kvasir) #(\d+)/g)].map(
        (m) => ({
          repo: (m[1] ?? m[3]) as string,
          num: (m[2] ?? m[4]) as string,
        }),
      );
      const mdate = firstDate(line) ?? firstDate(merged[0]) ?? date;
      entries.push({
        key: `${key}:merged`,
        type: "action",
        title: `${pad(n)} · Merged`,
        date: mdate,
        summary: brief(merged[0].replace(/\*\*/g, ""), 280),
        fields: {
          links: prs.map((p) => ({
            label: `${p.repo} #${p.num}`,
            url: `https://github.com/kineuro/${p.repo}/pull/${p.num}`,
          })),
        },
        tags: [...(src.tags ?? []), `record ${n}`],
        links: [{ to: key, kind: "led_to", reverse: true }],
      });
    }
  }
  return { entries, warnings };
}

function stateOf(preamble: string): string | undefined {
  if (/\bretired\b/i.test(preamble)) return "retired";
  if (/\bdeferred\b/i.test(preamble)) return "deferred";
  if (/\bin force\b/i.test(preamble)) return "in force";
  if (/\*\*(closed|merged)|\bclosed\b|\breleased (in|as)\b/i.test(preamble)) return "done";
  if (/\b(accepted|ratified)\b/i.test(preamble)) return "accepted";
  return undefined;
}

function firstParagraph(md: string): string {
  return (
    md
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .find((p) => p && !/^(\||```|#)/.test(p)) ?? ""
  );
}

function firstBody(parts: { body: string }[]): string {
  for (const p of parts) {
    const f = firstParagraph(p.body);
    if (f) return f;
  }
  return "";
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function dedupe(links: { to: string; kind: LinkKind; reverse?: boolean }[]) {
  const seen = new Set<string>();
  return links.filter((l) => {
    const k = `${l.to}|${l.kind}|${l.reverse ? 1 : 0}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** "S1 what it does; S2 ..." from a slices table, or the section's first paragraph. */
function sliceSummary(body: string): string {
  const rows = [...body.matchAll(/^\|\s*\**([A-Z]?\d+[a-z]?)\**\s*\|\s*([^|]+?)\s*\|/gm)].map(
    (m) =>
      `${m[1]} ${
        (m[2] as string)
          .replace(/\*\*/g, "")
          .replace(/`/g, "")
          .split(/(?<=[.:;])\s/)[0]
      }`,
  );
  if (rows.length) return brief(rows.join("; "), 300);
  return brief(firstParagraph(body) || body, 280);
}
