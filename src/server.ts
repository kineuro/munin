// SPDX-License-Identifier: AGPL-3.0-only
// The HTTP doors: the sign-in, the JSON API under /api and the page. Every door that reads or changes a timeline
// asks access.ts first; every door that changes something wants JSON and the X-Munin header, which a form on
// another site cannot send.
import { readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { type Context, Hono } from "hono";
import { type Access, accessTo, atLeast, canCreate, type Grant, grantsOf, type Principal } from "./access.js";
import { endSession, mayEnter, Oidc, principalOf, safeReturn, startSession, upsertUser } from "./auth.js";
import type { Config } from "./config.js";
import { type DB, ENTRY_TYPES, type EntryType, LEVELS, LINK_KINDS, now } from "./db.js";
import { render } from "./markdown.js";

type Env = { Variables: { who: Principal | null } };

interface TimelineRow {
  id: number;
  slug: string;
  title: string;
  summary: string;
  owner_id: number;
  now_md: string;
  next_md: string;
  waiting_md: string;
  picture_by_hand: number;
  created_at: string;
  updated_at: string;
}

interface EntryRow {
  id: number;
  timeline_id: number;
  source_key: string | null;
  type: EntryType;
  title: string;
  date: string;
  summary: string;
  body_md: string;
  fields_json: string;
  tags_json: string;
  status: string;
  by_hand: number;
  stale: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

class HttpError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

const FIELD_TEXT = ["question", "choice", "why", "lesson", "waitingOn", "decidedBy", "state"] as const;

export function createApp(db: DB, cfg: Config): Hono<Env> {
  const app = new Hono<Env>();
  const oidc = cfg.auth.mode === "oidc" ? new Oidc(cfg) : null;
  const version = packageVersion();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: "something went wrong on the server" }, 500);
  });

  app.use("*", async (c, next) => {
    c.set("who", principalOf(db, c));
    await next();
    c.header("Content-Security-Policy", CSP);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "same-origin");
    c.header("X-Frame-Options", "DENY");
  });

  // Changing doors: JSON, the header, and an Origin (when the browser sends one) that is ours.
  app.use("/api/*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      if (c.req.header("x-munin") !== "1") throw new HttpError(403, "missing the X-Munin header");
      const origin = c.req.header("origin");
      if (origin && origin !== new URL(cfg.origin).origin)
        throw new HttpError(403, "a request from another site");
    }
    await next();
  });

  app.get("/health", (c) => c.json({ ok: true, version }));

  // --- Signing in ---------------------------------------------------------------------------------------------
  app.get("/auth/login", async (c) => {
    if (oidc) return oidc.start(c);
    return c.redirect(`/signin?return=${encodeURIComponent(safeReturn(c.req.query("return")))}`);
  });
  app.get("/auth/callback", async (c) => {
    if (!oidc) throw new HttpError(404, "no provider is configured");
    try {
      const { claims, returnTo } = await oidc.finish(c);
      if (!mayEnter(cfg.auth, claims.groups))
        return c.text("Your account has no access to Munin. Ask an administrator.", 403);
      startSession(db, cfg, c, upsertUser(db, cfg.auth, claims));
      return c.redirect(returnTo);
    } catch (e) {
      return c.text(`Sign-in failed: ${(e as Error).message}`, 400);
    }
  });
  app.post("/auth/dev", async (c) => {
    if (cfg.auth.mode !== "dev") throw new HttpError(404, "dev sign-in is off");
    const form = await c.req.parseBody();
    const u = cfg.auth.devUsers.find((d) => d.username === form.username);
    if (!u) throw new HttpError(400, "no such made-up person");
    const id = upsertUser(db, cfg.auth, {
      sub: `dev:${u.username}`,
      username: u.username,
      name: u.name ?? u.username,
      email: "",
      groups: u.groups ?? [],
    });
    startSession(db, cfg, c, id);
    return c.redirect(safeReturn(typeof form.return === "string" ? form.return : "/"));
  });
  app.post("/auth/logout", (c) => {
    endSession(db, c);
    return c.redirect("/");
  });

  // --- Who am I -----------------------------------------------------------------------------------------------
  app.get("/api/me", (c) => {
    const who = c.get("who");
    return c.json({
      user: who ? { username: who.username, name: who.name, groups: who.groups, isAdmin: who.isAdmin } : null,
      mayCreate: who ? canCreate(who, cfg.auth.createGroups) : false,
      mode: cfg.auth.mode,
      devUsers:
        cfg.auth.mode === "dev"
          ? cfg.auth.devUsers.map((u) => ({ username: u.username, name: u.name ?? u.username }))
          : [],
      version,
    });
  });

  app.get("/api/directory", (c) => {
    signedIn(c);
    const users = db
      .prepare("SELECT username, name, groups_json FROM users WHERE sub != 'munin:system' ORDER BY name")
      .all() as { username: string; name: string; groups_json: string }[];
    const groups = new Set<string>([cfg.auth.adminGroup]);
    for (const u of users) for (const g of JSON.parse(u.groups_json) as string[]) groups.add(g);
    return c.json({
      users: users.map((u) => ({ username: u.username, name: u.name })),
      groups: [...groups].sort(),
    });
  });

  // --- Timelines ----------------------------------------------------------------------------------------------
  app.get("/api/timelines", (c) => {
    const who = signedIn(c);
    const rows = db.prepare("SELECT * FROM timelines ORDER BY updated_at DESC").all() as TimelineRow[];
    const out = [];
    for (const t of rows) {
      const access = accessTo(who, t, grantsOf(db, t.id));
      if (access === "none") continue;
      const counts = db
        .prepare(
          "SELECT type, COUNT(*) n, MIN(date) first, MAX(date) last FROM entries WHERE timeline_id = ? AND stale = 0 GROUP BY type",
        )
        .all(t.id) as { type: string; n: number; first: string; last: string }[];
      out.push({
        slug: t.slug,
        title: t.title,
        summary: t.summary,
        owner: userBrief(t.owner_id),
        access,
        updatedAt: t.updated_at,
        counts: Object.fromEntries(counts.map((r) => [r.type, r.n])),
        first: counts.reduce<string | null>((a, r) => (!a || r.first < a ? r.first : a), null),
        last: counts.reduce<string | null>((a, r) => (!a || r.last > a ? r.last : a), null),
      });
    }
    return c.json({ timelines: out });
  });

  app.post("/api/timelines", async (c) => {
    const who = signedIn(c);
    if (!canCreate(who, cfg.auth.createGroups)) throw new HttpError(403, "you may not create timelines here");
    const b = await json(c);
    const title = text(b.title, "title", 1, 120);
    const slug = (typeof b.slug === "string" && b.slug ? b.slug : title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new HttpError(400, "the address needs letters or digits");
    if (db.prepare("SELECT 1 FROM timelines WHERE slug = ?").get(slug))
      throw new HttpError(409, `"${slug}" is taken`);
    const t = now();
    db.prepare(
      "INSERT INTO timelines (slug, title, summary, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(slug, title, text(b.summary ?? "", "summary", 0, 2000), who.id, t, t);
    return c.json({ slug }, 201);
  });

  app.get("/api/timelines/:slug", (c) => {
    const who = signedIn(c);
    const { t, access } = timeline(c.req.param("slug"), who, "view");
    const entries = db
      .prepare("SELECT * FROM entries WHERE timeline_id = ? ORDER BY date, id")
      .all(t.id) as EntryRow[];
    const counts = new Map<number, { n: number; open: number }>();
    for (const r of db
      .prepare(
        `SELECT c.entry_id id, COUNT(*) n, SUM(CASE WHEN c.parent_id IS NULL AND c.resolved_at IS NULL THEN 1 ELSE 0 END) open
         FROM comments c JOIN entries e ON e.id = c.entry_id WHERE e.timeline_id = ? AND c.deleted = 0 GROUP BY c.entry_id`,
      )
      .all(t.id) as { id: number; n: number; open: number }[])
      counts.set(r.id, { n: r.n, open: r.open });
    const links = db
      .prepare(
        "SELECT l.id, l.from_id, l.to_id, l.kind, l.imported FROM links l JOIN entries e ON e.id = l.from_id WHERE e.timeline_id = ?",
      )
      .all(t.id);
    const last = db.prepare("SELECT * FROM imports WHERE timeline_id = ? ORDER BY id DESC LIMIT 1").get(t.id);
    const mention = mentionCheck();
    return c.json({
      timeline: {
        slug: t.slug,
        title: t.title,
        summary: t.summary,
        owner: userBrief(t.owner_id),
        access,
        picture: {
          now: t.now_md,
          next: t.next_md,
          waiting: t.waiting_md,
          nowHtml: render(t.now_md, { mention }),
          nextHtml: render(t.next_md, { mention }),
          waitingHtml: render(t.waiting_md, { mention }),
          byHand: t.picture_by_hand === 1,
        },
        grants: atLeast(access, "owner") ? grantsOf(db, t.id) : undefined,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
        lastImport: last ?? null,
      },
      entries: entries.map((e) => entryOut(e, counts.get(e.id), false, false)),
      links,
    });
  });

  app.patch("/api/timelines/:slug", async (c) => {
    const who = signedIn(c);
    const { t, access } = timeline(c.req.param("slug"), who, "edit");
    const b = await json(c);
    const set: Record<string, unknown> = {};
    if (b.title !== undefined) {
      if (!atLeast(access, "owner")) throw new HttpError(403, "only the owner renames a timeline");
      set.title = text(b.title, "title", 1, 120);
    }
    if (b.summary !== undefined) set.summary = text(b.summary, "summary", 0, 2000);
    if (b.picture !== undefined) {
      const p = b.picture as Record<string, unknown>;
      if (p.now !== undefined) set.now_md = text(p.now, "where we are", 0, 20000);
      if (p.next !== undefined) set.next_md = text(p.next, "what is next", 0, 20000);
      if (p.waiting !== undefined) set.waiting_md = text(p.waiting, "what waits", 0, 20000);
      set.picture_by_hand = p.byHand === false ? 0 : 1;
    }
    if (b.owner !== undefined) {
      if (!atLeast(access, "owner")) throw new HttpError(403, "only the owner hands a timeline on");
      const u = db
        .prepare("SELECT id FROM users WHERE username = ? AND sub != 'munin:system'")
        .get(String(b.owner)) as { id: number } | undefined;
      if (!u) throw new HttpError(400, "no such person has signed in yet");
      set.owner_id = u.id;
    }
    update("timelines", t.id, set);
    return c.json({ ok: true });
  });

  app.put("/api/timelines/:slug/grants", async (c) => {
    const who = signedIn(c);
    const { t } = timeline(c.req.param("slug"), who, "owner");
    const b = await json(c);
    if (!Array.isArray(b.grants)) throw new HttpError(400, "grants must be a list");
    const grants: Grant[] = (b.grants as unknown[]).map((g) => {
      const o = g as Record<string, unknown>;
      if (!["user", "group", "all"].includes(String(o.kind)))
        throw new HttpError(400, "a grant is for a user, a group or all");
      if (!(LEVELS as readonly string[]).includes(String(o.level)))
        throw new HttpError(400, "a grant's level is view, comment or edit");
      const name = o.kind === "all" ? "*" : text(o.name, "name", 1, 120);
      return { kind: o.kind as Grant["kind"], name, level: o.level as Grant["level"] };
    });
    db.transaction(() => {
      db.prepare("DELETE FROM grants WHERE timeline_id = ?").run(t.id);
      const ins = db.prepare(
        "INSERT OR REPLACE INTO grants (timeline_id, kind, name, level) VALUES (?, ?, ?, ?)",
      );
      for (const g of grants) ins.run(t.id, g.kind, g.name, g.level);
    })();
    return c.json({ grants: grantsOf(db, t.id) });
  });

  app.delete("/api/timelines/:slug", (c) => {
    const who = signedIn(c);
    const { t } = timeline(c.req.param("slug"), who, "owner");
    db.prepare("DELETE FROM timelines WHERE id = ?").run(t.id);
    return c.json({ ok: true });
  });

  // --- Entries ------------------------------------------------------------------------------------------------
  app.post("/api/timelines/:slug/entries", async (c) => {
    const who = signedIn(c);
    const { t } = timeline(c.req.param("slug"), who, "edit");
    const e = entryIn(await json(c), true);
    const ts = now();
    const id = Number(
      db
        .prepare(
          `INSERT INTO entries (timeline_id, type, title, date, summary, body_md, fields_json, tags_json, status, by_hand,
            created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        )
        .run(
          t.id,
          e.type,
          e.title,
          e.date,
          e.summary ?? "",
          e.body_md ?? "",
          e.fields_json ?? "{}",
          e.tags_json ?? "[]",
          e.status ?? "",
          who.id,
          ts,
          ts,
        ).lastInsertRowid,
    );
    touch(t.id);
    return c.json({ id }, 201);
  });

  app.get("/api/entries/:id", (c) => {
    const who = signedIn(c);
    const { e, access } = entry(Number(c.req.param("id")), who, "view");
    const counts = db
      .prepare(
        `SELECT COUNT(*) n, SUM(CASE WHEN parent_id IS NULL AND resolved_at IS NULL THEN 1 ELSE 0 END) open
         FROM comments WHERE entry_id = ? AND deleted = 0`,
      )
      .get(e.id) as { n: number; open: number | null };
    return c.json(entryOut(e, { n: counts.n, open: counts.open ?? 0 }, true, atLeast(access, "edit")));
  });

  // Words in the bodies, which the list does not carry; titles, summaries and fields are searched in the page.
  app.get("/api/timelines/:slug/search", (c) => {
    const who = signedIn(c);
    const { t } = timeline(c.req.param("slug"), who, "view");
    const q = (c.req.query("q") ?? "").trim().toLowerCase();
    if (q.length < 2) return c.json({ ids: [] });
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const ids = (
      db
        .prepare(
          `SELECT id FROM entries WHERE timeline_id = ? AND (lower(body_md) LIKE ? ESCAPE '\\' OR lower(title) LIKE ? ESCAPE '\\'
           OR lower(summary) LIKE ? ESCAPE '\\' OR lower(fields_json) LIKE ? ESCAPE '\\')`,
        )
        .all(t.id, like, like, like, like) as { id: number }[]
    ).map((r) => r.id);
    return c.json({ ids });
  });

  app.patch("/api/entries/:id", async (c) => {
    const who = signedIn(c);
    const { e, t } = entry(Number(c.req.param("id")), who, "edit");
    const b = await json(c);
    const set: Record<string, unknown> = entryIn(b, false);
    if (b.byHand === false) {
      if (!e.source_key) throw new HttpError(400, "this entry was written here; it has no source to follow");
      set.by_hand = 0;
    } else if (Object.keys(set).length) set.by_hand = 1;
    set.updated_at = now();
    update("entries", e.id, set);
    touch(t.id);
    return c.json({ ok: true });
  });

  app.delete("/api/entries/:id", (c) => {
    const who = signedIn(c);
    const { e, t, access } = entry(Number(c.req.param("id")), who, "edit");
    const n = (
      db.prepare("SELECT COUNT(*) n FROM comments WHERE entry_id = ? AND deleted = 0").get(e.id) as {
        n: number;
      }
    ).n;
    if (n && !atLeast(access, "owner"))
      throw new HttpError(409, "this entry has comments; only the owner can delete it");
    if (e.source_key && !e.stale)
      throw new HttpError(409, "an imported entry comes back with the next import; edit it instead");
    db.prepare("DELETE FROM entries WHERE id = ?").run(e.id);
    touch(t.id);
    return c.json({ ok: true });
  });

  app.post("/api/entries/:id/links", async (c) => {
    const who = signedIn(c);
    const { e } = entry(Number(c.req.param("id")), who, "edit");
    const b = await json(c);
    const to = db.prepare("SELECT id, timeline_id FROM entries WHERE id = ?").get(Number(b.to)) as
      | { id: number; timeline_id: number }
      | undefined;
    if (!to || to.timeline_id !== e.timeline_id)
      throw new HttpError(400, "link to an entry of the same timeline");
    if (to.id === e.id) throw new HttpError(400, "an entry cannot lead to itself");
    if (!(LINK_KINDS as readonly string[]).includes(String(b.kind)))
      throw new HttpError(400, "unknown kind of link");
    const r = db
      .prepare("INSERT OR IGNORE INTO links (from_id, to_id, kind) VALUES (?, ?, ?)")
      .run(e.id, to.id, String(b.kind));
    return c.json({ id: Number(r.lastInsertRowid) }, 201);
  });

  app.delete("/api/links/:id", (c) => {
    const who = signedIn(c);
    const l = db.prepare("SELECT id, from_id FROM links WHERE id = ?").get(Number(c.req.param("id"))) as
      | { id: number; from_id: number }
      | undefined;
    if (!l) throw new HttpError(404, "no such link");
    entry(l.from_id, who, "edit");
    db.prepare("DELETE FROM links WHERE id = ?").run(l.id);
    return c.json({ ok: true });
  });

  // --- Comments -----------------------------------------------------------------------------------------------
  app.get("/api/entries/:id/comments", (c) => {
    const who = signedIn(c);
    const { e, access } = entry(Number(c.req.param("id")), who, "view");
    const rows = db
      .prepare(
        `SELECT c.*, u.username, u.name, r.username resolver FROM comments c JOIN users u ON u.id = c.author_id
         LEFT JOIN users r ON r.id = c.resolved_by WHERE c.entry_id = ? ORDER BY c.created_at, c.id`,
      )
      .all(e.id) as {
      id: number;
      parent_id: number | null;
      author_id: number;
      body_md: string;
      created_at: string;
      edited_at: string | null;
      resolved_at: string | null;
      resolver: string | null;
      deleted: number;
      username: string;
      name: string;
    }[];
    const mention = mentionCheck();
    return c.json({
      mayComment: atLeast(access, "comment"),
      comments: rows.map((r) => ({
        id: r.id,
        parentId: r.parent_id,
        author: { username: r.username, name: r.name },
        mine: r.author_id === who.id,
        bodyHtml: r.deleted ? "" : render(r.body_md, { mention }),
        body: r.deleted || r.author_id !== who.id ? undefined : r.body_md,
        createdAt: r.created_at,
        editedAt: r.edited_at,
        resolvedAt: r.resolved_at,
        resolvedBy: r.resolver,
        deleted: r.deleted === 1,
      })),
    });
  });

  app.post("/api/entries/:id/comments", async (c) => {
    const who = signedIn(c);
    const { e } = entry(Number(c.req.param("id")), who, "comment");
    const b = await json(c);
    const body = text(b.body, "comment", 1, 20000);
    let parent: number | null = null;
    if (b.parentId != null) {
      const p = db
        .prepare("SELECT id, entry_id, parent_id FROM comments WHERE id = ?")
        .get(Number(b.parentId)) as { id: number; entry_id: number; parent_id: number | null } | undefined;
      if (!p || p.entry_id !== e.id) throw new HttpError(400, "reply to a comment on the same entry");
      parent = p.parent_id ?? p.id;
    }
    const id = Number(
      db
        .prepare(
          "INSERT INTO comments (entry_id, parent_id, author_id, body_md, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(e.id, parent, who.id, body, now()).lastInsertRowid,
    );
    recordMentions(id, body);
    return c.json({ id }, 201);
  });

  app.patch("/api/comments/:id", async (c) => {
    const who = signedIn(c);
    const cm = db.prepare("SELECT * FROM comments WHERE id = ?").get(Number(c.req.param("id"))) as
      | { id: number; entry_id: number; parent_id: number | null; author_id: number; deleted: number }
      | undefined;
    if (!cm || cm.deleted) throw new HttpError(404, "no such comment");
    entry(cm.entry_id, who, "comment");
    const b = await json(c);
    if (b.body !== undefined) {
      if (cm.author_id !== who.id) throw new HttpError(403, "only its author edits a comment");
      const body = text(b.body, "comment", 1, 20000);
      db.prepare("UPDATE comments SET body_md = ?, edited_at = ? WHERE id = ?").run(body, now(), cm.id);
      db.prepare("DELETE FROM mentions WHERE comment_id = ?").run(cm.id);
      recordMentions(cm.id, body);
    }
    if (b.resolved !== undefined) {
      if (cm.parent_id) throw new HttpError(400, "a thread is resolved at its first comment");
      if (b.resolved)
        db.prepare("UPDATE comments SET resolved_at = ?, resolved_by = ? WHERE id = ?").run(
          now(),
          who.id,
          cm.id,
        );
      else db.prepare("UPDATE comments SET resolved_at = NULL, resolved_by = NULL WHERE id = ?").run(cm.id);
    }
    return c.json({ ok: true });
  });

  app.delete("/api/comments/:id", (c) => {
    const who = signedIn(c);
    const cm = db
      .prepare("SELECT id, entry_id, author_id FROM comments WHERE id = ?")
      .get(Number(c.req.param("id"))) as { id: number; entry_id: number; author_id: number } | undefined;
    if (!cm) throw new HttpError(404, "no such comment");
    const { access } = entry(cm.entry_id, who, "comment");
    if (cm.author_id !== who.id && !atLeast(access, "owner"))
      throw new HttpError(403, "only its author or the owner removes a comment");
    // The comment's place in the thread stays, so replies keep their context.
    db.prepare("UPDATE comments SET deleted = 1, body_md = '' WHERE id = ?").run(cm.id);
    db.prepare("DELETE FROM mentions WHERE comment_id = ?").run(cm.id);
    return c.json({ ok: true });
  });

  // --- The page -----------------------------------------------------------------------------------------------
  app.get("*", (c) => {
    const p = c.req.path;
    if (p.startsWith("/api/")) throw new HttpError(404, "no such door");
    const file = staticFile(cfg.web, p);
    if (file) {
      c.header("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
      c.header("Cache-Control", p.startsWith("/assets/") ? "public, max-age=3600" : "no-cache");
      return c.body(readFileSync(file));
    }
    c.header("Content-Type", TYPES[".html"] as string);
    c.header("Cache-Control", "no-cache");
    return c.body(readFileSync(join(cfg.web, "index.html")));
  });

  // --- Helpers ------------------------------------------------------------------------------------------------
  function signedIn(c: Context<Env>): Principal {
    const who = c.get("who");
    if (!who) throw new HttpError(401, "sign in first");
    return who;
  }

  function timeline(slug: string, who: Principal, want: Access): { t: TimelineRow; access: Access } {
    const t = db.prepare("SELECT * FROM timelines WHERE slug = ?").get(slug) as TimelineRow | undefined;
    const access = t ? accessTo(who, t, grantsOf(db, t.id)) : "none";
    // A timeline you may not see does not exist, as far as you can tell.
    if (!t || access === "none") throw new HttpError(404, "no such timeline");
    if (!atLeast(access, want)) throw new HttpError(403, `this needs ${want} access`);
    return { t, access };
  }

  function entry(id: number, who: Principal, want: Access): { e: EntryRow; t: TimelineRow; access: Access } {
    const e = db.prepare("SELECT * FROM entries WHERE id = ?").get(id) as EntryRow | undefined;
    if (!e) throw new HttpError(404, "no such entry");
    const t = db.prepare("SELECT * FROM timelines WHERE id = ?").get(e.timeline_id) as TimelineRow;
    const access = accessTo(who, t, grantsOf(db, t.id));
    if (access === "none") throw new HttpError(404, "no such entry");
    if (!atLeast(access, want)) throw new HttpError(403, `this needs ${want} access`);
    return { e, t, access };
  }

  function userBrief(id: number) {
    const u = db.prepare("SELECT username, name FROM users WHERE id = ?").get(id) as
      | { username: string; name: string }
      | undefined;
    return u ?? { username: "?", name: "?" };
  }

  function mentionCheck(): (name: string) => boolean {
    const names = new Set(
      (db.prepare("SELECT username FROM users").all() as { username: string }[]).map((r) => r.username),
    );
    return (n) => names.has(n);
  }

  function recordMentions(commentId: number, body: string) {
    const ins = db.prepare(
      "INSERT OR IGNORE INTO mentions (comment_id, user_id) SELECT ?, id FROM users WHERE username = ? AND sub != 'munin:system'",
    );
    for (const m of body.matchAll(/(?:^|[\s(])@([A-Za-z0-9._-]*[A-Za-z0-9_])/g)) ins.run(commentId, m[1]);
  }

  function update(table: "timelines" | "entries", id: number, set: Record<string, unknown>) {
    const keys = Object.keys(set);
    if (!keys.length) return;
    if (table === "timelines") set.updated_at = now();
    const cols = Object.keys(set);
    db.prepare(`UPDATE ${table} SET ${cols.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(
      ...cols.map((k) => set[k]),
      id,
    );
  }

  function touch(timelineId: number) {
    db.prepare("UPDATE timelines SET updated_at = ? WHERE id = ?").run(now(), timelineId);
  }

  /** An entry for the list (no rendered text) or in full (its body and fields rendered, and their sources to edit). */
  function entryOut(
    e: EntryRow,
    counts: { n: number; open: number } | undefined,
    full: boolean,
    editable: boolean,
  ) {
    const fields = JSON.parse(e.fields_json) as Record<string, unknown>;
    const html: Record<string, string> = {};
    if (full) {
      const mention = mentionCheck();
      for (const k of FIELD_TEXT)
        if (typeof fields[k] === "string") html[k] = render(fields[k] as string, { mention });
    }
    return {
      id: e.id,
      key: e.source_key,
      type: e.type,
      title: e.title,
      date: e.date,
      summary: e.summary,
      hasBody: e.body_md.trim().length > 0,
      bodyHtml: full ? render(e.body_md, { mention: mentionCheck() }) : undefined,
      body: full && editable ? e.body_md : undefined,
      fields: full ? fields : pick(fields, ["decidedBy", "state", "waitingOn"]),
      fieldsHtml: full ? html : undefined,
      tags: JSON.parse(e.tags_json) as string[],
      status: e.status,
      byHand: e.by_hand === 1,
      imported: e.source_key !== null,
      stale: e.stale === 1,
      comments: counts?.n ?? 0,
      openThreads: counts?.open ?? 0,
      updatedAt: e.updated_at,
    };
  }

  return app;
}

function pick(o: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

async function json(c: Context): Promise<Record<string, unknown>> {
  if (!(c.req.header("content-type") ?? "").includes("application/json"))
    throw new HttpError(400, "send JSON");
  try {
    const b = await c.req.json();
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error();
    return b as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "the body is not a JSON object");
  }
}

function text(v: unknown, name: string, min: number, max: number): string {
  if (typeof v !== "string") throw new HttpError(400, `${name} must be text`);
  const s = v.trim();
  if (s.length < min) throw new HttpError(400, `${name} is needed`);
  if (s.length > max) throw new HttpError(400, `${name} is longer than ${max} characters`);
  return s;
}

const FIELD_KEYS = new Set([
  "question",
  "choice",
  "why",
  "decidedBy",
  "alternatives",
  "sources",
  "links",
  "metrics",
  "chart",
  "lesson",
  "waitingOn",
  "state",
]);

function entryIn(b: Record<string, unknown>, creating: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  if (creating || b.type !== undefined) {
    if (!(ENTRY_TYPES as readonly string[]).includes(String(b.type)))
      throw new HttpError(400, "unknown entry type");
    out.type = String(b.type);
  }
  if (creating || b.title !== undefined) out.title = text(b.title, "title", 1, 300);
  if (creating || b.date !== undefined) {
    const d = String(b.date ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d)))
      throw new HttpError(400, "date is YYYY-MM-DD");
    out.date = d;
  }
  if (b.summary !== undefined) out.summary = text(b.summary, "summary", 0, 2000);
  if (b.body !== undefined) out.body_md = text(b.body, "body", 0, 200000);
  if (b.status !== undefined) {
    if (!["", "open", "closed"].includes(String(b.status)))
      throw new HttpError(400, "status is open, closed or empty");
    out.status = String(b.status);
  }
  if (b.tags !== undefined) {
    if (
      !Array.isArray(b.tags) ||
      b.tags.length > 40 ||
      b.tags.some((t) => typeof t !== "string" || t.length > 60)
    )
      throw new HttpError(400, "tags are a short list of short words");
    out.tags_json = JSON.stringify((b.tags as string[]).map((t) => t.trim()).filter(Boolean));
  }
  if (b.fields !== undefined) {
    const f = b.fields as Record<string, unknown>;
    if (!f || typeof f !== "object" || Array.isArray(f)) throw new HttpError(400, "fields is an object");
    for (const k of Object.keys(f)) if (!FIELD_KEYS.has(k)) throw new HttpError(400, `unknown field ${k}`);
    const s = JSON.stringify(f);
    if (s.length > 200000) throw new HttpError(400, "fields are too large");
    out.fields_json = s;
  }
  return out;
}

function staticFile(root: string, urlPath: string): string | null {
  let p: string;
  try {
    p = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (p === "/" || p.includes("\0")) return null;
  const full = normalize(join(root, p));
  if (!full.startsWith(normalize(root) + sep)) return null;
  try {
    return statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    return pkg.version;
  } catch {
    return "0.0.0";
  }
}
