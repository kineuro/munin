// SPDX-License-Identifier: AGPL-3.0-only
// Signing in. Munin never keeps a password: people sign in at an OpenID Connect provider (authorization code with
// PKCE), and Munin keeps a session of its own, a random token whose hash is in the database. In `dev` mode, for a
// laptop, a page lists made-up people to be.
import { createHash, randomBytes } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import type { Principal } from "./access.js";
import { type AuthConfig, type Config, readSecret } from "./config.js";
import { type DB, now } from "./db.js";

export const SESSION_COOKIE = "munin_session";
const LOGIN_COOKIE = "munin_login";

export function hashToken(t: string): string {
  return createHash("sha256").update(t).digest("hex");
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export interface Claims {
  sub: string;
  username: string;
  name: string;
  email: string;
  groups: string[];
}

/** Makes or refreshes the person behind a sign-in, and returns their id. */
export function upsertUser(db: DB, auth: AuthConfig, c: Claims): number {
  const t = now();
  const isAdmin = c.groups.includes(auth.adminGroup) ? 1 : 0;
  const row = db.prepare("SELECT id FROM users WHERE sub = ?").get(c.sub) as { id: number } | undefined;
  if (row) {
    db.prepare(
      "UPDATE users SET name = ?, email = ?, groups_json = ?, is_admin = ?, last_seen = ? WHERE id = ?",
    ).run(c.name, c.email, JSON.stringify(c.groups), isAdmin, t, row.id);
    return row.id;
  }
  let username = c.username.replace(/[^A-Za-z0-9._-]/g, "") || "user";
  for (let i = 2; db.prepare("SELECT 1 FROM users WHERE username = ?").get(username); i++) {
    username = `${c.username.replace(/[^A-Za-z0-9._-]/g, "") || "user"}${i}`;
  }
  return Number(
    db
      .prepare(
        "INSERT INTO users (sub, username, name, email, groups_json, is_admin, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(c.sub, username, c.name, c.email, JSON.stringify(c.groups), isAdmin, t, t).lastInsertRowid,
  );
}

export function startSession(db: DB, cfg: Config, c: Context, userId: number): void {
  const token = b64url(randomBytes(32));
  const t = new Date();
  const exp = new Date(t.getTime() + cfg.sessionDays * 86400_000);
  db.prepare("INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
    hashToken(token),
    userId,
    t.toISOString(),
    exp.toISOString(),
  );
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(t.toISOString());
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: cfg.origin.startsWith("https://"),
    sameSite: "Lax",
    path: "/",
    expires: exp,
  });
}

export function principalOf(db: DB, c: Context): Principal | null {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.name, u.groups_json, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id_hash = ? AND s.expires_at > ?`,
    )
    .get(hashToken(token), now()) as
    | { id: number; username: string; name: string; groups_json: string; is_admin: number }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    groups: JSON.parse(row.groups_json) as string[],
    isAdmin: row.is_admin === 1,
  };
}

export function endSession(db: DB, c: Context): void {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(hashToken(token));
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

/** A path on this site to come back to, never another origin. */
export function safeReturn(p: string | undefined | null): string {
  if (!p?.startsWith("/") || p.startsWith("//") || p.startsWith("/\\")) return "/";
  return p;
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
  end_session_endpoint?: string;
}

interface Pending {
  verifier: string;
  nonce: string;
  returnTo: string;
  at: number;
}

export class Oidc {
  private discovery?: Discovery;
  private jwks?: ReturnType<typeof createRemoteJWKSet>;
  private pending = new Map<string, Pending>();

  constructor(private cfg: Config) {}

  private async disc(): Promise<Discovery> {
    if (this.discovery) return this.discovery;
    const issuer = (this.cfg.auth.issuer as string).replace(/\/$/, "");
    const res = await fetch(`${issuer}/.well-known/openid-configuration`);
    if (!res.ok) throw new Error(`the provider's discovery answered ${res.status}`);
    this.discovery = (await res.json()) as Discovery;
    this.jwks = createRemoteJWKSet(new URL(this.discovery.jwks_uri));
    return this.discovery;
  }

  private redirectUri(): string {
    return `${this.cfg.origin.replace(/\/$/, "")}/auth/callback`;
  }

  async start(c: Context): Promise<Response> {
    const d = await this.disc();
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(32));
    const nonce = b64url(randomBytes(16));
    const t = Date.now();
    for (const [k, v] of this.pending) if (t - v.at > 600_000) this.pending.delete(k);
    this.pending.set(state, { verifier, nonce, returnTo: safeReturn(c.req.query("return")), at: t });
    setCookie(c, LOGIN_COOKIE, state, {
      httpOnly: true,
      secure: this.cfg.origin.startsWith("https://"),
      sameSite: "Lax",
      path: "/auth",
      maxAge: 600,
    });
    const u = new URL(d.authorization_endpoint);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", this.cfg.auth.clientId as string);
    u.searchParams.set("redirect_uri", this.redirectUri());
    u.searchParams.set("scope", (this.cfg.auth.scopes ?? ["openid", "email", "profile"]).join(" "));
    u.searchParams.set("state", state);
    u.searchParams.set("nonce", nonce);
    u.searchParams.set("code_challenge", b64url(createHash("sha256").update(verifier).digest()));
    u.searchParams.set("code_challenge_method", "S256");
    return c.redirect(u.toString());
  }

  /** Checks the provider's answer and returns who signed in, and where to go back to. */
  async finish(c: Context): Promise<{ claims: Claims; returnTo: string }> {
    const state = c.req.query("state") ?? "";
    const code = c.req.query("code") ?? "";
    const cookie = getCookie(c, LOGIN_COOKIE);
    deleteCookie(c, LOGIN_COOKIE, { path: "/auth" });
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || !cookie || cookie !== state || Date.now() - p.at > 600_000)
      throw new Error("the sign-in expired; start again");
    if (!code)
      throw new Error(
        c.req.query("error_description") ?? c.req.query("error") ?? "the provider sent no code",
      );
    const d = await this.disc();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri(),
      code_verifier: p.verifier,
      client_id: this.cfg.auth.clientId as string,
      client_secret: readSecret(this.cfg.auth.clientSecretFile as string),
    });
    const res = await fetch(d.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
    });
    if (!res.ok) throw new Error(`the provider refused the code (${res.status})`);
    const tok = (await res.json()) as { id_token?: string };
    if (!tok.id_token) throw new Error("the provider sent no id_token");
    const { payload } = await jwtVerify(tok.id_token, this.jwks as ReturnType<typeof createRemoteJWKSet>, {
      issuer: d.issuer,
      audience: this.cfg.auth.clientId as string,
    });
    if (payload.nonce !== p.nonce) throw new Error("the sign-in's nonce does not match");
    return { claims: claimsOf(payload, this.cfg.auth), returnTo: p.returnTo };
  }
}

export function claimsOf(p: JWTPayload, auth: AuthConfig): Claims {
  const g = p[auth.groupsClaim ?? "groups"];
  const groups = Array.isArray(g) ? g.filter((x): x is string => typeof x === "string") : [];
  const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : "");
  if (!p.sub) throw new Error("the token names nobody (no sub)");
  const username = str("preferred_username") || str("email").split("@")[0] || p.sub;
  return { sub: p.sub, username, name: str("name") || username, email: str("email"), groups };
}

export function mayEnter(auth: AuthConfig, groups: string[]): boolean {
  if (!auth.allowGroups.length) return true;
  return groups.includes(auth.adminGroup) || groups.some((g) => auth.allowGroups.includes(g));
}
