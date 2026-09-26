// SPDX-License-Identifier: AGPL-3.0-only
// GitHub releases as milestones. Several repositories that share version numbers (an engine and its web app, say)
// become one milestone per tag. The releases are read from the GitHub API with a token, or from a JSON file saved
// from it (`gh api repos/OWNER/REPO/releases --paginate`).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { brief, type ImportedEntry, localDate, recordRefs, type SourceOutput } from "./types.js";

export interface ReleasesSource {
  kind: "releases";
  /** OWNER/REPO, the first one leads: its notes are the milestone's. */
  repos: string[];
  /** Saved API answers per repo, instead of asking GitHub. */
  files?: Record<string, string>;
  key?: string;
  /** Record key prefix, to link a release to the records its notes name. */
  recordKey?: string;
  /** A Markdown table `| version | date | record | ... |` that names records for early versions. */
  recordTable?: string;
  /** Title template, `{tag}` and `{name}` filled in. */
  title?: string;
  tags?: string[];
}

interface Release {
  tag_name: string;
  name: string | null;
  body: string | null;
  published_at: string | null;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
}

function token(): string | undefined {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

async function fetchReleases(repo: string): Promise<Release[]> {
  const t = token();
  const all: Release[] = [];
  for (let page = 1; page < 20; page++) {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, {
      headers: { accept: "application/vnd.github+json", ...(t ? { authorization: `Bearer ${t}` } : {}) },
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for the releases of ${repo}`);
    const batch = (await res.json()) as Release[];
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

function recordsByVersion(table: string): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const line of readFileSync(table, "utf8").split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    const v = /^alpha\.(\d+)$/.exec(cells[1] ?? "");
    if (!v) continue;
    const recs = (cells[3] ?? "").match(/\d{1,2}/g)?.map(Number) ?? [];
    if (recs.length) map.set(`alpha.${v[1]}`, recs);
  }
  return map;
}

export async function readReleases(src: ReleasesSource): Promise<SourceOutput> {
  const prefix = src.key ?? "release";
  const warnings: string[] = [];
  const byRepo = new Map<string, Release[]>();
  for (const repo of src.repos) {
    const file = src.files?.[repo];
    const list = file ? (JSON.parse(readFileSync(file, "utf8")) as Release[]) : await fetchReleases(repo);
    byRepo.set(
      repo,
      list.filter((r) => !r.draft && r.published_at),
    );
  }
  const table = src.recordTable ? recordsByVersion(src.recordTable) : new Map<string, number[]>();
  const [lead, ...rest] = src.repos as [string, ...string[]];
  const tags = new Map<string, { lead?: Release; others: { repo: string; r: Release }[] }>();
  for (const [repo, list] of byRepo) {
    for (const r of list) {
      const slot = tags.get(r.tag_name) ?? { others: [] };
      if (repo === lead) slot.lead = r;
      else slot.others.push({ repo, r });
      tags.set(r.tag_name, slot);
    }
  }
  const entries: (ImportedEntry & { at: string })[] = [];
  for (const [tag, slot] of tags) {
    const main = slot.lead ?? slot.others[0]?.r;
    if (!main?.published_at) continue;
    const body = (main.body ?? "").trim();
    const parts = [body];
    for (const o of slot.others) {
      if (!o.r.body?.trim()) continue;
      parts.push(`#### ${o.repo.split("/")[1]}\n\n${o.r.body.trim()}`);
    }
    const short = tag.replace(/^v1\.0\.0-/, "");
    const refs = new Set<number>([...recordRefs(body), ...(table.get(short) ?? [])]);
    const allRepos = [lead, ...rest].filter((repo) =>
      repo === lead ? slot.lead : slot.others.some((o) => o.repo === repo),
    );
    entries.push({
      at: main.published_at,
      key: `${prefix}:${tag}`,
      type: "milestone",
      title: (src.title ?? "{tag}")
        .replace("{tag}", tag.replace(/^v/, ""))
        .replace("{name}", main.name ?? tag),
      date: localDate(main.published_at),
      summary: brief(body.split(/\n\s*\n/).find((p) => p.trim() && !/^\s*(#|\||```)/.test(p)) ?? "", 360),
      body: parts.join("\n\n"),
      fields: {
        links: [
          ...(slot.lead ? [{ label: `${lead.split("/")[1]} ${tag}`, url: slot.lead.html_url }] : []),
          ...slot.others.map((o) => ({ label: `${o.repo.split("/")[1]} ${tag}`, url: o.r.html_url })),
        ],
      },
      tags: [...(src.tags ?? []), ...allRepos.map((r) => r.split("/")[1] as string)],
      links: src.recordKey
        ? [...refs].map((n) => ({ to: `${src.recordKey}:${n}`, kind: "led_to" as const, reverse: true }))
        : [],
    });
  }
  entries.sort((a, b) => a.at.localeCompare(b.at));
  return { entries: entries.map(({ at: _at, ...e }) => e), warnings };
}
