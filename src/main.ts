#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// munin serve | import | users | owner: the one command.
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { loadManifest, runImport } from "./import.js";
import { createApp } from "./server.js";

const HELP = `munin: project timelines with threaded comments

  munin serve  --config munin.json
  munin import --config munin.json --manifest sources.json
  munin users  --config munin.json
  munin owner  --config munin.json --timeline SLUG --user USERNAME
`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      config: { type: "string", default: process.env.MUNIN_CONFIG },
      manifest: { type: "string" },
      timeline: { type: "string" },
      user: { type: "string" },
    },
  });
  if (!cmd || cmd === "help" || cmd === "--help") {
    process.stdout.write(HELP);
    return;
  }
  const cfg = loadConfig(values.config);
  const db = openDb(cfg.db);
  switch (cmd) {
    case "serve": {
      const app = createApp(db, cfg);
      serve({ fetch: app.fetch, hostname: cfg.listen.host, port: cfg.listen.port }, (info) => {
        console.log(
          `munin on http://${info.address}:${info.port} (${cfg.auth.mode} sign-in), origin ${cfg.origin}`,
        );
      });
      const stop = () => {
        db.close();
        process.exit(0);
      };
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);
      return;
    }
    case "import": {
      if (!values.manifest) throw new Error("--manifest is required");
      const report = await runImport(db, loadManifest(values.manifest));
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    case "users": {
      for (const u of db
        .prepare("SELECT username, name, is_admin, last_seen FROM users ORDER BY username")
        .all() as {
        username: string;
        name: string;
        is_admin: number;
        last_seen: string;
      }[])
        console.log(`${u.username}\t${u.name}\t${u.is_admin ? "admin" : ""}\t${u.last_seen}`);
      return;
    }
    case "owner": {
      const u = db.prepare("SELECT id FROM users WHERE username = ?").get(values.user ?? "") as
        | { id: number }
        | undefined;
      if (!u) throw new Error("no such user; they sign in once first");
      const r = db
        .prepare("UPDATE timelines SET owner_id = ? WHERE slug = ?")
        .run(u.id, values.timeline ?? "");
      if (!r.changes) throw new Error("no such timeline");
      console.log(`${values.timeline} now belongs to ${values.user}`);
      return;
    }
    default:
      process.stderr.write(HELP);
      process.exit(2);
  }
}

main().catch((e: Error) => {
  console.error(`munin: ${e.message}`);
  process.exit(1);
});
