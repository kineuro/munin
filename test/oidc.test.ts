// SPDX-License-Identifier: AGPL-3.0-only
// The OpenID Connect sign-in against a small fake provider on a loopback port: discovery, PKCE, the code, the
// ID token's signature, issuer, audience and nonce, and the groups that make an administrator.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Config, DEFAULTS } from "../src/config.js";
import { openDb } from "../src/db.js";
import { createApp } from "../src/server.js";

let server: Server;
let issuer = "";
let dir: string;
const codes = new Map<string, { nonce: string; challenge: string }>();
let claims: Record<string, unknown> = {};
let tamper = false;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    if (url.pathname.endsWith("/.well-known/openid-configuration")) {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}authorize`,
          token_endpoint: `${issuer}token`,
          jwks_uri: `${issuer}jwks`,
        }),
      );
    } else if (url.pathname.endsWith("/jwks")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ keys: [jwk] }));
    } else if (url.pathname.endsWith("/token")) {
      let body = "";
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      const c = codes.get(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      const ok =
        c &&
        form.get("client_secret") === "s3cret" &&
        createHash("sha256").update(verifier).digest("base64url") === c.challenge;
      if (!ok) {
        res.statusCode = 400;
        res.end("{}");
        return;
      }
      const token = await new SignJWT({ ...claims, nonce: tamper ? "other" : c.nonce })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(issuer)
        .setAudience("munin")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id_token: token, access_token: "a", token_type: "Bearer" }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/o/munin/`;
  dir = mkdtempSync(join(tmpdir(), "munin-oidc-"));
  writeFileSync(join(dir, "secret"), "s3cret\n");
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

function app() {
  const cfg: Config = structuredClone(DEFAULTS);
  cfg.auth = {
    ...cfg.auth,
    mode: "oidc",
    issuer,
    clientId: "munin",
    clientSecretFile: join(dir, "secret"),
    allowGroups: ["staff"],
  };
  cfg.web = join(__dirname, "..", "web");
  return createApp(openDb(join(dir, `${Math.random()}.db`)), cfg);
}

async function signIn(a: ReturnType<typeof app>) {
  const start = await a.request("/auth/login?return=/t/nils");
  expect(start.status).toBe(302);
  const to = new URL(start.headers.get("location") ?? "");
  expect(to.searchParams.get("code_challenge_method")).toBe("S256");
  expect(to.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:8080/auth/callback");
  const state = to.searchParams.get("state") ?? "";
  const loginCookie = (start.headers.get("set-cookie") ?? "").split(";")[0] as string;
  const code = `c${Math.random()}`;
  codes.set(code, {
    nonce: to.searchParams.get("nonce") ?? "",
    challenge: to.searchParams.get("code_challenge") ?? "",
  });
  return a.request(`/auth/callback?code=${code}&state=${state}`, { headers: { cookie: loginCookie } });
}

describe("oidc", () => {
  it("signs a person in, keeps their groups and makes admins of the admin group", async () => {
    const a = app();
    claims = {
      sub: "u-1",
      preferred_username: "rae",
      name: "Rae",
      email: "rae@example.org",
      groups: ["staff", "admin"],
    };
    const done = await signIn(a);
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe("/t/nils");
    const session = (done.headers.get("set-cookie") ?? "").match(/munin_session=[^;]+/)?.[0] ?? "";
    const me = await (await a.request("/api/me", { headers: { cookie: session } })).json();
    expect(me.user).toMatchObject({ username: "rae", isAdmin: true, groups: ["staff", "admin"] });
  });

  it("refuses a token with the wrong nonce, and people outside the allowed groups", async () => {
    const a = app();
    claims = { sub: "u-2", preferred_username: "sam", groups: ["staff"] };
    tamper = true;
    expect((await signIn(a)).status).toBe(400);
    tamper = false;
    claims = { sub: "u-3", preferred_username: "tim", groups: ["external"] };
    expect((await signIn(a)).status).toBe(403);
  });

  it("refuses a callback without the browser's login cookie", async () => {
    const a = app();
    const start = await a.request("/auth/login");
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    expect((await a.request(`/auth/callback?code=x&state=${state}`)).status).toBe(400);
  });
});
