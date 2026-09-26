// SPDX-License-Identifier: AGPL-3.0-only
// The doors, as made-up people in dev mode: sharing, the threads, and what each person may and may not do.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Config, DEFAULTS } from "../src/config.js";
import { type DB, openDb } from "../src/db.js";
import { createApp } from "../src/server.js";

let dir: string;
let db: DB;
let app: ReturnType<typeof createApp>;

async function signIn(username: string): Promise<string> {
  const res = await app.request("/auth/dev", {
    method: "POST",
    body: new URLSearchParams({ username, return: "/" }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  expect(res.status).toBe(302);
  const cookie = res.headers.get("set-cookie") ?? "";
  return cookie.split(";")[0] as string;
}

function call(
  cookie: string | null,
  method: string,
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
) {
  const headers: Record<string, string> = { ...extra };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && !("x-munin" in extra)) headers["x-munin"] = "1";
  return app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "munin-api-"));
  db = openDb(join(dir, "m.db"));
  const cfg: Config = {
    ...structuredClone(DEFAULTS),
    db: join(dir, "m.db"),
    web: join(__dirname, "..", "web"),
  };
  cfg.auth.createGroups = ["staff", "admin"];
  app = createApp(db, cfg);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("api", () => {
  it("asks for a sign-in, and knows who you are after it", async () => {
    expect((await call(null, "GET", "/api/timelines")).status).toBe(401);
    const me = await (await call(null, "GET", "/api/me")).json();
    expect(me.user).toBeNull();
    const ben = await signIn("ben");
    const me2 = await (await call(ben, "GET", "/api/me")).json();
    expect(me2.user).toMatchObject({ username: "ben", isAdmin: false });
    expect(me2.mayCreate).toBe(true);
  });

  it("refuses a change without the header, from another site, or without JSON", async () => {
    const ben = await signIn("ben");
    expect((await call(ben, "POST", "/api/timelines", { title: "X" }, { "x-munin": "" })).status).toBe(403);
    expect(
      (await call(ben, "POST", "/api/timelines", { title: "X" }, { origin: "https://evil.example" })).status,
    ).toBe(403);
    const r = await app.request("/api/timelines", {
      method: "POST",
      headers: { cookie: ben, "x-munin": "1" },
      body: "title=X",
    });
    expect(r.status).toBe(400);
  });

  it("keeps a timeline to its owner and admins until it is shared", async () => {
    const ben = await signIn("ben");
    const cleo = await signIn("cleo");
    const ada = await signIn("ada");
    expect((await call(cleo, "POST", "/api/timelines", { title: "Nope" })).status).toBe(403);
    const created = await call(ben, "POST", "/api/timelines", { title: "The PCCT study" });
    expect(created.status).toBe(201);
    const { slug } = await created.json();
    expect(slug).toBe("the-pcct-study");
    expect((await call(cleo, "GET", `/api/timelines/${slug}`)).status).toBe(404);
    expect((await (await call(cleo, "GET", "/api/timelines")).json()).timelines).toHaveLength(0);
    expect((await (await call(ada, "GET", `/api/timelines/${slug}`)).json()).timeline.access).toBe("owner");

    const e = await (
      await call(ben, "POST", `/api/timelines/${slug}/entries`, {
        type: "decision",
        title: "Scan at 0.2 mm",
        date: "2026-10-01",
        fields: { choice: "yes", decidedBy: "ben" },
      })
    ).json();
    await call(ben, "PUT", `/api/timelines/${slug}/grants`, {
      grants: [{ kind: "user", name: "cleo", level: "view" }],
    });
    const seen = await (await call(cleo, "GET", `/api/timelines/${slug}`)).json();
    expect(seen.timeline.access).toBe("view");
    expect(seen.timeline.grants).toBeUndefined();
    expect(seen.entries[0]).toMatchObject({ title: "Scan at 0.2 mm", type: "decision" });
    expect((await call(cleo, "POST", `/api/entries/${e.id}/comments`, { body: "hm" })).status).toBe(403);
    expect((await call(cleo, "PATCH", `/api/entries/${e.id}`, { title: "x" })).status).toBe(403);
    expect((await call(cleo, "PUT", `/api/timelines/${slug}/grants`, { grants: [] })).status).toBe(403);

    await call(ben, "PUT", `/api/timelines/${slug}/grants`, {
      grants: [{ kind: "group", name: "external", level: "comment" }],
    });
    expect((await call(cleo, "POST", `/api/entries/${e.id}/comments`, { body: "hm" })).status).toBe(201);
  });

  it("threads: replies, resolving, mentions, editing and removing", async () => {
    const ben = await signIn("ben");
    const ada = await signIn("ada");
    const { slug } = await (await call(ben, "POST", "/api/timelines", { title: "T" })).json();
    const e = await (
      await call(ben, "POST", `/api/timelines/${slug}/entries`, {
        type: "result",
        title: "R",
        date: "2026-10-02",
        fields: { metrics: [{ label: "n", value: 3 }] },
      })
    ).json();
    const top = await (
      await call(ada, "POST", `/api/entries/${e.id}/comments`, { body: "Why 3, @ben? <b>x</b>" })
    ).json();
    const reply = await (
      await call(ben, "POST", `/api/entries/${e.id}/comments`, { body: "Because.", parentId: top.id })
    ).json();
    // a reply to a reply joins the same thread
    const deep = await (
      await call(ada, "POST", `/api/entries/${e.id}/comments`, { body: "ok", parentId: reply.id })
    ).json();
    let list = await (await call(ben, "GET", `/api/entries/${e.id}/comments`)).json();
    expect(list.comments.map((c: { parentId: number | null }) => c.parentId)).toEqual([null, top.id, top.id]);
    expect(list.comments[0].bodyHtml).toContain('<span class="mention">@ben</span>');
    expect(list.comments[0].bodyHtml).not.toContain("<b>");
    expect((db.prepare("SELECT COUNT(*) n FROM mentions").get() as { n: number }).n).toBe(1);

    let tl = await (await call(ben, "GET", `/api/timelines/${slug}`)).json();
    expect(tl.entries[0]).toMatchObject({ comments: 3, openThreads: 1 });
    expect((await call(ben, "PATCH", `/api/comments/${reply.id}`, { resolved: true })).status).toBe(400);
    expect((await call(ben, "PATCH", `/api/comments/${top.id}`, { resolved: true })).status).toBe(200);
    tl = await (await call(ben, "GET", `/api/timelines/${slug}`)).json();
    expect(tl.entries[0].openThreads).toBe(0);

    expect((await call(ben, "PATCH", `/api/comments/${deep.id}`, { body: "not mine" })).status).toBe(403);
    expect((await call(ada, "PATCH", `/api/comments/${deep.id}`, { body: "ok then" })).status).toBe(200);
    expect((await call(ada, "DELETE", `/api/comments/${reply.id}`)).status).toBe(200); // ada is an admin, so she may remove any comment
    list = await (await call(ben, "GET", `/api/entries/${e.id}/comments`)).json();
    expect(list.comments[1]).toMatchObject({ deleted: true, bodyHtml: "" });
    expect(list.comments).toHaveLength(3);
  });

  it("an imported entry edited by hand stays so, and cannot be deleted while its source has it", async () => {
    const ada = await signIn("ada");
    const { slug } = await (await call(ada, "POST", "/api/timelines", { title: "I" })).json();
    const tid = (db.prepare("SELECT id FROM timelines WHERE slug = ?").get(slug) as { id: number }).id;
    const id = Number(
      db
        .prepare(
          "INSERT INTO entries (timeline_id, source_key, type, title, date, created_at, updated_at) VALUES (?, 'x:1', 'action', 'A', '2026-01-01', 'x', 'x')",
        )
        .run(tid).lastInsertRowid,
    );
    expect((await call(ada, "DELETE", `/api/entries/${id}`)).status).toBe(409);
    await call(ada, "PATCH", `/api/entries/${id}`, { title: "Better" });
    const full = await (await call(ada, "GET", `/api/entries/${id}`)).json();
    expect(full).toMatchObject({ title: "Better", byHand: true, imported: true });
    await call(ada, "PATCH", `/api/entries/${id}`, { byHand: false });
    expect((await (await call(ada, "GET", `/api/entries/${id}`)).json()).byHand).toBe(false);
  });

  it("validates what it stores", async () => {
    const ben = await signIn("ben");
    const { slug } = await (await call(ben, "POST", "/api/timelines", { title: "V" })).json();
    const bad = [
      { type: "rumour", title: "x", date: "2026-01-01" },
      { type: "action", title: "", date: "2026-01-01" },
      { type: "action", title: "x", date: "01/01/2026" },
      { type: "action", title: "x", date: "2026-01-01", fields: { password: "no" } },
    ];
    for (const b of bad)
      expect((await call(ben, "POST", `/api/timelines/${slug}/entries`, b)).status).toBe(400);
  });

  it("serves the page for any path that is not a door", async () => {
    const r = await app.request("/t/anything");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(await r.text()).toContain("<title>Munin</title>");
    expect(await (await app.request("/../package.json")).text()).toContain("<title>Munin</title>");
    expect(await (await app.request("/%2e%2e/package.json")).text()).toContain("<title>Munin</title>");
  });
});
