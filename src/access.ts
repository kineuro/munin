// SPDX-License-Identifier: AGPL-3.0-only
// Who may do what on a timeline. One function answers it; every door asks it.
import type { DB, Level } from "./db.js";

export interface Principal {
  id: number;
  username: string;
  name: string;
  groups: string[];
  isAdmin: boolean;
}

/** `owner` can do everything `edit` can, and also share, rename and delete the timeline. */
export type Access = "none" | Level | "owner";

const RANK: Record<Access, number> = { none: 0, view: 1, comment: 2, edit: 3, owner: 4 };

export function atLeast(a: Access, want: Access): boolean {
  return RANK[a] >= RANK[want];
}

export interface Grant {
  kind: "user" | "group" | "all";
  name: string;
  level: Level;
}

export function accessTo(who: Principal | null, timeline: { owner_id: number }, grants: Grant[]): Access {
  if (!who) return "none";
  if (who.isAdmin || timeline.owner_id === who.id) return "owner";
  let best: Access = "none";
  for (const g of grants) {
    const applies =
      g.kind === "all" ||
      (g.kind === "user" && g.name === who.username) ||
      (g.kind === "group" && who.groups.includes(g.name));
    if (applies && RANK[g.level] > RANK[best]) best = g.level;
  }
  return best;
}

export function grantsOf(db: DB, timelineId: number): Grant[] {
  return db
    .prepare("SELECT kind, name, level FROM grants WHERE timeline_id = ? ORDER BY kind, name")
    .all(timelineId) as Grant[];
}

export function canCreate(who: Principal, createGroups: "all" | string[]): boolean {
  if (who.isAdmin || createGroups === "all") return true;
  return who.groups.some((g) => createGroups.includes(g));
}
