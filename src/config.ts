// SPDX-License-Identifier: AGPL-3.0-only
// Munin's configuration: one JSON file, every field with a default, secrets read from files named in it.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface DevUser {
  username: string;
  name?: string;
  groups?: string[];
}

export interface AuthConfig {
  /** `oidc` signs people in at an OpenID Connect provider; `dev` offers a list of made-up people and binds loopback only. */
  mode: "oidc" | "dev";
  issuer?: string;
  clientId?: string;
  clientSecretFile?: string;
  scopes?: string[];
  /** The claim that lists a person's groups (Authentik: `groups`). */
  groupsClaim?: string;
  /** Members of this group see and change every timeline. */
  adminGroup: string;
  /** Who may sign in at all: empty means anyone the provider lets through. */
  allowGroups: string[];
  /** Who may create timelines: `all` signed-in people, or the members of these groups. */
  createGroups: "all" | string[];
  devUsers: DevUser[];
}

export interface Config {
  listen: { host: string; port: number };
  /** The public origin, for redirects and cookies: https://munin.example.org */
  origin: string;
  db: string;
  web: string;
  sessionDays: number;
  auth: AuthConfig;
}

export const DEFAULTS: Config = {
  listen: { host: "127.0.0.1", port: 8080 },
  origin: "http://127.0.0.1:8080",
  db: "munin.db",
  web: "web",
  sessionDays: 14,
  auth: {
    mode: "dev",
    scopes: ["openid", "email", "profile"],
    groupsClaim: "groups",
    adminGroup: "admin",
    allowGroups: [],
    createGroups: "all",
    devUsers: [
      { username: "ada", name: "Ada (admin)", groups: ["admin"] },
      { username: "ben", name: "Ben", groups: ["staff"] },
      { username: "cleo", name: "Cleo", groups: ["external"] },
    ],
  },
};

export function loadConfig(path?: string): Config {
  if (!path) return structuredClone(DEFAULTS);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Config> & { auth?: Partial<AuthConfig> };
  const base = dirname(resolve(path));
  const cfg: Config = {
    ...structuredClone(DEFAULTS),
    ...raw,
    listen: { ...DEFAULTS.listen, ...(raw.listen ?? {}) },
    auth: { ...structuredClone(DEFAULTS.auth), ...(raw.auth ?? {}) },
  };
  cfg.db = resolve(base, cfg.db);
  cfg.web = resolve(base, cfg.web);
  if (cfg.auth.clientSecretFile) cfg.auth.clientSecretFile = resolve(base, cfg.auth.clientSecretFile);
  validate(cfg);
  return cfg;
}

export function validate(cfg: Config): void {
  if (cfg.auth.mode === "oidc") {
    for (const k of ["issuer", "clientId", "clientSecretFile"] as const) {
      if (!cfg.auth[k]) throw new Error(`auth.${k} is required when auth.mode is oidc`);
    }
    if (!cfg.origin.startsWith("https://") && !isLoopback(cfg.listen.host)) {
      throw new Error("an oidc install on a non-loopback address needs an https origin");
    }
  } else if (cfg.auth.mode === "dev") {
    if (!isLoopback(cfg.listen.host)) {
      throw new Error(
        "auth.mode dev lets anyone pick who they are, so it listens on a loopback address only",
      );
    }
  } else {
    throw new Error(`auth.mode must be oidc or dev, not ${String(cfg.auth.mode)}`);
  }
}

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function readSecret(path: string): string {
  return readFileSync(path, "utf8").trim();
}
