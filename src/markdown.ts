// SPDX-License-Identifier: AGPL-3.0-only
// A small Markdown renderer that cannot emit markup it did not build: every character of the source is escaped
// before any tag is added, and a link keeps its target only when it is http, https or mailto.

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeHref(url: string): string | null {
  const u = url.trim();
  if (/^(https?:\/\/|mailto:)/i.test(u)) return u;
  return null;
}

export interface RenderOptions {
  /** Marks `@name` when the name is known. */
  mention?: (name: string) => boolean;
}

/** Inline spans: code, links, bold, italic, bare URLs and mentions. */
export function inline(src: string, opts: RenderOptions = {}): string {
  const out: string[] = [];
  const parts = src.split(/(`+[^`]*?`+)/g);
  for (const part of parts) {
    if (/^`+[^`]*`+$/.test(part) && part.length > 1) {
      out.push(`<code>${escapeHtml(part.replace(/^`+|`+$/g, ""))}</code>`);
      continue;
    }
    out.push(spans(part, opts));
  }
  return out.join("");
}

function spans(text: string, opts: RenderOptions): string {
  // Links first, on the raw text, so their parts are escaped separately.
  const re = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let last = 0;
  let html = "";
  for (let m = re.exec(text); m; m = re.exec(text)) {
    html += emphasis(text.slice(last, m.index), opts);
    const href = safeHref(m[2] as string);
    const label = emphasis(m[1] as string, opts, false);
    html += href ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${label}</a>` : label;
    last = m.index + m[0].length;
  }
  html += emphasis(text.slice(last), opts);
  return html;
}

function emphasis(text: string, opts: RenderOptions, autolink = true): string {
  let s = escapeHtml(text);
  s = s.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^\w])_([^_\s][^_]*?)_(?!\w)/g, "$1<em>$2</em>");
  if (autolink)
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:])/g, (_m, pre: string, url: string) => {
      return `${pre}<a href="${url}" rel="noopener noreferrer">${url}</a>`;
    });
  if (opts.mention) {
    const known = opts.mention;
    s = s.replace(/(^|[\s(])@([A-Za-z0-9._-]*[A-Za-z0-9_])/g, (m, pre: string, name: string) =>
      known(name) ? `${pre}<span class="mention">@${name}</span>` : m,
    );
  }
  return s;
}

function splitRow(line: string): string[] {
  let l = line.trim();
  if (l.startsWith("|")) l = l.slice(1);
  if (l.endsWith("|")) l = l.slice(0, -1);
  return l.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

export function render(src: string, opts: RenderOptions = {}): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  return blocks(lines, opts);
}

function blocks(lines: string[], opts: RenderOptions): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] as string).trim().startsWith(fence[1] as string))
        body.push(lines[i++] as string);
      i++;
      out.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const level = Math.min(6, (h[1] as string).length + 2);
      out.push(`<h${level}>${inline(h[2] as string, opts)}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] as string))
        body.push((lines[i++] as string).replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${blocks(body, opts)}</blockquote>`);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] as string)) {
      const head = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] as string).includes("|") && !/^\s*$/.test(lines[i] as string)) {
        rows.push(splitRow(lines[i++] as string));
      }
      const th = head.map((c) => `<th>${inline(c, opts)}</th>`).join("");
      const tb = rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, opts)}</td>`).join("")}</tr>`).join("");
      out.push(`<div class="table"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`);
      continue;
    }
    if (LIST.test(line)) {
      i = list(lines, i, out, opts);
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i] as string) &&
      !/^(#{1,6}\s|\s*>|\s*```|\s*~~~)/.test(lines[i] as string) &&
      !(para.length > 0 && LIST.test(lines[i] as string))
    ) {
      para.push((lines[i++] as string).trim());
    }
    out.push(`<p>${inline(para.join(" "), opts)}</p>`);
  }
  return out.join("\n");
}

function list(lines: string[], start: number, out: string[], opts: RenderOptions): number {
  const first = LIST.exec(lines[start] as string) as RegExpExecArray;
  const indent = (first[1] as string).length;
  const ordered = /\d/.test(first[2] as string);
  const items: string[] = [];
  let i = start;
  while (i < lines.length) {
    const m = LIST.exec(lines[i] as string);
    if (!m || (m[1] as string).length < indent) break;
    if ((m[1] as string).length > indent) {
      const nested: string[] = [];
      i = list(lines, i, nested, opts);
      if (items.length) items[items.length - 1] += nested.join("");
      continue;
    }
    let text = m[3] as string;
    i++;
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i] as string) &&
      !LIST.test(lines[i] as string) &&
      /^\s+/.test(lines[i] as string)
    ) {
      text += ` ${(lines[i++] as string).trim()}`;
    }
    items.push(inline(text, opts));
  }
  const tag = ordered ? "ol" : "ul";
  out.push(`<${tag}>${items.map((it) => `<li>${it}</li>`).join("")}</${tag}>`);
  return i;
}
