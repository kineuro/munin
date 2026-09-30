// SPDX-License-Identifier: AGPL-3.0-only
// Runs a manifest of sources into one timeline. Idempotent: every entry has a stable key per source, so a second
// run changes only what changed. It never touches comments, never overwrites an entry someone edited by hand, and
// marks an entry whose source is gone as stale instead of deleting it.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { type DB, now, systemUser } from "./db.js";
import { type AdrSource, readAdr } from "./importers/adr.js";
import { type ChangelogSource, readChangelog } from "./importers/changelog.js";
import { type EntriesSource, readEntries } from "./importers/entries.js";
import { type GitSource, readGit } from "./importers/git.js";
import { type HistorySource, readHistory } from "./importers/history.js";
import { type ReleasesSource, readReleases } from "./importers/releases.js";
import { readStudies, type StudiesSource } from "./importers/studies.js";
import type { ImportedEntry, Picture, SourceOutput } from "./importers/types.js";
import { compileRules, type RedactRule, scrubDeep } from "./scrub.js";

export type Source =
  | AdrSource
  | ReleasesSource
  | ChangelogSource
  | GitSource
  | HistorySource
  | StudiesSource
  | EntriesSource;

export interface Manifest {
  timeline: { slug: string; title: string; summary?: string; owner?: string };
  sources: Source[];
  /** Rules of the project's own, run after the built-in ones: inline, or a JSON file (`[...]` or `{ "rules": [...] }`). */
  redact?: RedactRule[] | string;
}

export interface ImportReport {
  timeline: string;
  created: number;
  updated: number;
  unchanged: number;
  kept: number;
  stale: number;
  redactions: number;
  /** Replacements per rule, built-in and the manifest's own. */
  redactionsByRule: Record<string, number>;
  links: number;
  unresolved: string[];
  warnings: string[];
  byType: Record<string, number>;
}

const PATH_KEYS = ["dir", "file", "repo", "recordTable"];

/** Reads a manifest and makes its relative paths relative to the manifest's folder. */
export function loadManifest(path: string): Manifest {
  const m = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  const base = dirname(resolve(path));
  const fix = (p: string) => (isAbsolute(p) ? p : resolve(base, p));
  for (const s of m.sources) {
    const r = s as unknown as Record<string, unknown>;
    for (const k of PATH_KEYS) {
      if (typeof r[k] === "string" && !(s.kind === "releases" && k === "repo")) r[k] = fix(r[k] as string);
    }
    if (s.kind === "history") s.files = s.files.map(fix);
    if (s.kind === "releases" && s.files)
      for (const k of Object.keys(s.files)) s.files[k] = fix(s.files[k] as string);
  }
  if (typeof m.redact === "string") {
    const r = JSON.parse(readFileSync(fix(m.redact), "utf8")) as RedactRule[] | { rules: RedactRule[] };
    if (!Array.isArray(r) && !Array.isArray(r?.rules))
      throw new Error(`redact: ${m.redact} holds no list of rules`);
    m.redact = Array.isArray(r) ? r : r.rules;
  }
  compileRules(m.redact as RedactRule[] | undefined);
  return m;
}

export async function collect(sources: Source[]): Promise<SourceOutput> {
  const out: SourceOutput = { entries: [], overrides: {}, links: [], warnings: [] };
  for (const s of sources) {
    let r: SourceOutput;
    switch (s.kind) {
      case "adr":
        r = readAdr(s);
        break;
      case "releases":
        r = await readReleases(s);
        break;
      case "changelog":
        r = readChangelog(s);
        break;
      case "git":
        r = readGit(s);
        break;
      case "history":
        r = readHistory(s);
        break;
      case "studies":
        r = readStudies(s);
        break;
      case "entries":
        r = readEntries(s);
        break;
      default:
        throw new Error(`unknown source kind ${(s as { kind: string }).kind}`);
    }
    out.entries.push(...r.entries);
    out.links?.push(...(r.links ?? []));
    Object.assign(out.overrides as object, r.overrides ?? {});
    if (r.picture) out.picture = { ...(out.picture ?? {}), ...r.picture };
    out.warnings.push(...r.warnings);
  }
  return out;
}

function hashOf(e: ImportedEntry): string {
  return createHash("sha256")
    .update(JSON.stringify([e.type, e.title, e.date, e.summary, e.body, e.fields, e.tags, e.status]))
    .digest("hex");
}

export function applyImport(db: DB, manifest: Manifest, data: SourceOutput): ImportReport {
  if (typeof manifest.redact === "string") throw new Error("redact: load the manifest with loadManifest");
  const extra = compileRules(manifest.redact);
  const counter = { n: 0, byRule: {} as Record<string, number> };
  const seen = new Map<string, ImportedEntry>();
  const warnings = [...data.warnings];
  for (const e of data.entries) {
    if (seen.has(e.key)) {
      warnings.push(`duplicate key ${e.key}: the first one is kept`);
      continue;
    }
    const o = data.overrides?.[e.key];
    const merged: ImportedEntry = o
      ? { ...e, ...o, fields: { ...(e.fields ?? {}), ...(o.fields ?? {}) } }
      : e;
    seen.set(e.key, scrubDeep(merged, counter, extra));
  }
  for (const k of Object.keys(data.overrides ?? {}))
    if (!seen.has(k)) warnings.push(`override for ${k}: no such entry`);
  const picture: Picture | undefined = data.picture ? scrubDeep(data.picture, counter, extra) : undefined;

  const report: ImportReport = {
    timeline: manifest.timeline.slug,
    created: 0,
    updated: 0,
    unchanged: 0,
    kept: 0,
    stale: 0,
    redactions: counter.n,
    redactionsByRule: counter.byRule,
    links: 0,
    unresolved: [],
    warnings,
    byType: {},
  };

  db.transaction(() => {
    const sys = systemUser(db);
    const t = now();
    let tl = db
      .prepare("SELECT id, picture_by_hand FROM timelines WHERE slug = ?")
      .get(manifest.timeline.slug) as { id: number; picture_by_hand: number } | undefined;
    if (!tl) {
      const owner = manifest.timeline.owner
        ? ((
            db.prepare("SELECT id FROM users WHERE username = ?").get(manifest.timeline.owner) as
              | { id: number }
              | undefined
          )?.id ?? sys)
        : sys;
      const id = Number(
        db
          .prepare(
            "INSERT INTO timelines (slug, title, summary, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(manifest.timeline.slug, manifest.timeline.title, manifest.timeline.summary ?? "", owner, t, t)
          .lastInsertRowid,
      );
      tl = { id, picture_by_hand: 0 };
    }
    const timelineId = tl.id;
    const existing = new Map<string, { id: number; by_hand: number; hash: string; stale: number }>();
    for (const r of db
      .prepare(
        "SELECT id, source_key, by_hand, stale, type, title, date, summary, body_md, fields_json, tags_json, status FROM entries WHERE timeline_id = ? AND source_key IS NOT NULL",
      )
      .all(timelineId) as {
      id: number;
      source_key: string;
      by_hand: number;
      stale: number;
      type: string;
      title: string;
      date: string;
      summary: string;
      body_md: string;
      fields_json: string;
      tags_json: string;
      status: string;
    }[]) {
      const e = {
        key: r.source_key,
        type: r.type,
        title: r.title,
        date: r.date,
        summary: r.summary,
        body: r.body_md,
        fields: JSON.parse(r.fields_json),
        tags: JSON.parse(r.tags_json),
        status: r.status,
      } as ImportedEntry;
      existing.set(r.source_key, { id: r.id, by_hand: r.by_hand, hash: hashOf(e), stale: r.stale });
    }
    const ins = db.prepare(
      `INSERT INTO entries (timeline_id, source_key, type, title, date, summary, body_md, fields_json, tags_json, status,
        created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const upd = db.prepare(
      `UPDATE entries SET type = ?, title = ?, date = ?, summary = ?, body_md = ?, fields_json = ?, tags_json = ?,
        status = ?, stale = 0, updated_at = ? WHERE id = ?`,
    );
    const ids = new Map<string, number>();
    for (const [key, raw] of seen) {
      const e: ImportedEntry = {
        ...raw,
        summary: raw.summary ?? "",
        body: raw.body ?? "",
        fields: stripEmpty(raw.fields ?? {}),
        tags: raw.tags ?? [],
        status: raw.status ?? "",
      };
      report.byType[e.type] = (report.byType[e.type] ?? 0) + 1;
      const row = existing.get(key);
      if (!row) {
        const id = Number(
          ins.run(
            timelineId,
            key,
            e.type,
            e.title,
            e.date,
            e.summary,
            e.body,
            JSON.stringify(e.fields),
            JSON.stringify(e.tags),
            e.status,
            sys,
            t,
            t,
          ).lastInsertRowid,
        );
        ids.set(key, id);
        report.created++;
        continue;
      }
      ids.set(key, row.id);
      if (row.by_hand) {
        if (row.stale) db.prepare("UPDATE entries SET stale = 0 WHERE id = ?").run(row.id);
        report.kept++;
        continue;
      }
      if (row.hash === hashOf(e) && !row.stale) {
        report.unchanged++;
        continue;
      }
      upd.run(
        e.type,
        e.title,
        e.date,
        e.summary,
        e.body,
        JSON.stringify(e.fields),
        JSON.stringify(e.tags),
        e.status,
        t,
        row.id,
      );
      report.updated++;
    }
    for (const [key, row] of existing) {
      if (!seen.has(key) && !row.stale) {
        db.prepare("UPDATE entries SET stale = 1, updated_at = ? WHERE id = ?").run(t, row.id);
        report.stale++;
      }
    }
    // Imported links are rebuilt on every run; links people made are left alone.
    db.prepare(
      "DELETE FROM links WHERE imported = 1 AND from_id IN (SELECT id FROM entries WHERE timeline_id = ?)",
    ).run(timelineId);
    const link = db.prepare(
      "INSERT OR IGNORE INTO links (from_id, to_id, kind, imported) VALUES (?, ?, ?, 1)",
    );
    for (const [key, e] of seen) {
      for (const l of e.links ?? []) {
        const a = ids.get(key);
        const b = ids.get(l.to);
        if (!a || !b) {
          report.unresolved.push(`${key} -> ${l.to}`);
          continue;
        }
        if (a === b) continue;
        const [from, to] = l.reverse ? [b, a] : [a, b];
        report.links += link.run(from, to, l.kind).changes;
      }
    }
    for (const l of data.links ?? []) {
      const a = ids.get(l.from);
      const b = ids.get(l.to);
      if (!a || !b || a === b) {
        report.unresolved.push(`${l.from} -> ${l.to}`);
        continue;
      }
      report.links += link.run(a, b, l.kind).changes;
    }
    if (picture && !tl.picture_by_hand) {
      db.prepare(
        "UPDATE timelines SET now_md = ?, next_md = ?, waiting_md = ?, updated_at = ? WHERE id = ?",
      ).run(picture.now ?? "", picture.next ?? "", picture.waiting ?? "", t, timelineId);
    }
    db.prepare("UPDATE timelines SET updated_at = ? WHERE id = ?").run(t, timelineId);
    db.prepare(
      "INSERT INTO imports (timeline_id, at, created, updated, unchanged, kept, stale, redactions) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      timelineId,
      t,
      report.created,
      report.updated,
      report.unchanged,
      report.kept,
      report.stale,
      report.redactions,
    );
  })();
  return report;
}

function stripEmpty<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  return out as T;
}

export async function runImport(db: DB, manifest: Manifest): Promise<ImportReport> {
  return applyImport(db, manifest, await collect(manifest.sources));
}
