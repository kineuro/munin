// SPDX-License-Identifier: AGPL-3.0-only
// What an import may never carry. A timeline holds decisions, counts and links; anything that looks like a person's
// identifier or a place where data lives is replaced before it is written, and counted so the import says so.

interface Rule {
  name: string;
  re: RegExp;
  to: string;
}

const RULES: Rule[] = [
  // Swedish personal identity numbers and coordination numbers, with or without the century and the separator.
  {
    name: "personal number",
    re: /\b(?:19|20)?\d{2}(?:0[1-9]|1[0-2])(?:[0-2]\d|3[01]|[6-8]\d|9[01])[-+]?\d{4}\b/g,
    to: "[id]",
  },
  // DICOM UIDs: dotted numeric strings of five parts or more.
  { name: "uid", re: /\b\d+(?:\.\d+){4,}\b/g, to: "[uid]" },
  // E-mail addresses.
  { name: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, to: "[email]" },
  // BIDS subject labels with a real-looking label.
  { name: "subject label", re: /\bsub-(?=[A-Za-z]*\d)[A-Za-z0-9]{3,}\b/g, to: "sub-[id]" },
  // Subject codes and other hashed identifiers: long runs of hex, not part of a URL.
  { name: "hash", re: /(?<![/\w=#-])[0-9a-f]{20,}(?![\w/])/gi, to: "[hash]" },
  // Paths where data lives: source trees, exchanges, archives, mounts, NAS volumes.
  {
    name: "data path",
    re: /(?<![\w.-])(?:~|\/(?:data|mnt|fast|volume\d+|exchange|archive|srv|media))(?:\/[^\s`'")\]|,;]+)+/g,
    to: "[path]",
  },
  // Home directories, including the one on a laptop.
  { name: "home path", re: /(?<![\w.-])\/home\/[^\s`'")\]|,;]+/g, to: "[path]" },
];

export interface ScrubResult {
  text: string;
  redactions: number;
}

export function scrub(text: string): ScrubResult {
  let redactions = 0;
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.re, () => {
      redactions++;
      return rule.to;
    });
  }
  return { text: out, redactions };
}

/** Scrubs every string inside a JSON-shaped value. */
export function scrubDeep<T>(value: T, counter: { n: number }): T {
  if (typeof value === "string") {
    const r = scrub(value);
    counter.n += r.redactions;
    return r.text as T;
  }
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, counter)) as T;
  if (value && typeof value === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value))
      o[k] = k === "url" || k === "href" ? v : scrubDeep(v, counter);
    return o as T;
  }
  return value;
}
