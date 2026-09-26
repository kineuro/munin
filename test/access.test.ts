// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { accessTo, atLeast, canCreate, type Principal } from "../src/access.js";

const p = (id: number, username: string, groups: string[] = [], isAdmin = false): Principal => ({
  id,
  username,
  name: username,
  groups,
  isAdmin,
});

describe("access", () => {
  const tl = { owner_id: 1 };
  it("gives the owner and admins everything, and nobody else anything by default", () => {
    expect(accessTo(p(1, "own"), tl, [])).toBe("owner");
    expect(accessTo(p(9, "adm", ["admin"], true), tl, [])).toBe("owner");
    expect(accessTo(p(2, "ben"), tl, [])).toBe("none");
    expect(accessTo(null, tl, [{ kind: "all", name: "*", level: "edit" }])).toBe("none");
  });
  it("takes the highest of the grants that apply", () => {
    const grants = [
      { kind: "all" as const, name: "*", level: "view" as const },
      { kind: "group" as const, name: "staff", level: "comment" as const },
      { kind: "user" as const, name: "ben", level: "edit" as const },
    ];
    expect(accessTo(p(2, "ben", ["staff"]), tl, grants)).toBe("edit");
    expect(accessTo(p(3, "cleo", ["staff"]), tl, grants)).toBe("comment");
    expect(accessTo(p(4, "dan"), tl, grants)).toBe("view");
    expect(atLeast("comment", "view")).toBe(true);
    expect(atLeast("comment", "edit")).toBe(false);
  });
  it("limits who may create", () => {
    expect(canCreate(p(2, "ben", ["staff"]), ["staff"])).toBe(true);
    expect(canCreate(p(3, "cleo", ["external"]), ["staff"])).toBe(false);
    expect(canCreate(p(3, "cleo"), "all")).toBe(true);
  });
});
