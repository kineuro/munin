// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { render } from "../src/markdown.js";

describe("markdown", () => {
  it("escapes every tag in the source", () => {
    const html = render('<script>alert(1)</script> <img src=x onerror="y">');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("keeps a link only when it is http, https or mailto", () => {
    expect(render("[a](javascript:alert(1))")).not.toContain("href");
    expect(render("[a](https://example.org/x)")).toContain('href="https://example.org/x"');
    expect(render('[a](https://example.org/"onmouseover="x)')).not.toMatch(/"onmouseover=/);
  });

  it("renders the shapes the records use", () => {
    const html = render(
      "## Head\n\n- one\n- **two**\n  - nested\n\n> quoted\n\n| a | b |\n|---|---|\n| 1 | `2` |\n\n```\n<raw>\n```",
    );
    expect(html).toContain("<h4>Head</h4>");
    expect(html).toContain("<li><strong>two</strong><ul><li>nested</li></ul></li>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<td><code>2</code></td>");
    expect(html).toContain("<pre><code>&lt;raw&gt;</code></pre>");
  });

  it("marks mentions of known people only", () => {
    const html = render("ask @ada and @nobody", { mention: (n) => n === "ada" });
    expect(html).toContain('<span class="mention">@ada</span>');
    expect(html).toContain("@nobody");
    expect(html).not.toContain('"mention">@nobody');
  });
});
