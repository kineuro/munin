// SPDX-License-Identifier: AGPL-3.0-only
// Entries written by hand in a JSON file, kept beside the other sources so they survive a rebuilt database:
// `entries` (each with its own `key`), `overrides` (fields laid over another source's entry, by key), `links`
// (between any two keys) and `picture` (the timeline's where we are, what is next and what waits).
import { readFileSync } from "node:fs";
import { ENTRY_TYPES } from "../db.js";
import type { ExtraLink, ImportedEntry, Picture, SourceOutput } from "./types.js";

export interface EntriesSource {
  kind: "entries";
  file: string;
  key?: string;
}

interface EntriesFile {
  entries?: ImportedEntry[];
  overrides?: Record<string, Partial<ImportedEntry>>;
  links?: ExtraLink[];
  picture?: Picture;
}

export function readEntries(src: EntriesSource): SourceOutput {
  const data = JSON.parse(readFileSync(src.file, "utf8")) as EntriesFile;
  const prefix = src.key ?? "hand";
  const warnings: string[] = [];
  const entries: ImportedEntry[] = [];
  for (const e of data.entries ?? []) {
    if (!e.key || !e.title || !/^\d{4}-\d{2}-\d{2}$/.test(e.date ?? "") || !ENTRY_TYPES.includes(e.type)) {
      warnings.push(
        `an entry in ${src.file} lacks a key, a title, a date or a known type: ${JSON.stringify(e).slice(0, 80)}`,
      );
      continue;
    }
    entries.push({ ...e, key: e.key.includes(":") ? e.key : `${prefix}:${e.key}` });
  }
  return {
    entries,
    overrides: data.overrides ?? {},
    links: data.links ?? [],
    picture: data.picture,
    warnings,
  };
}
