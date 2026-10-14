import { ProjectId } from "@t3tools/contracts";
import type { PoolLevel } from "@t3tools/contracts/sections";
import { describe, expect, it } from "@effect/vitest";

import { chainOf, type PoolTree, resolvePool } from "./poolChain.ts";
import type { PoolBinding } from "./ResourceBindings.ts";

const top: PoolLevel = { _tag: "top" };
const section = (sectionId: string): PoolLevel => ({ _tag: "section", sectionId });
const project = (id: string): PoolLevel => ({ _tag: "project", projectId: ProjectId.make(id) });

/** Personal at the top; Work under it, Clients under Work; the app in Clients, notes loose. */
const parents = new Map<string, PoolLevel | null>([
  ["top", null],
  ["section:work", top],
  ["section:clients", section("work")],
  ["project:app", section("clients")],
  ["project:notes", top],
]);
const keyOf = (level: PoolLevel) =>
  level._tag === "top"
    ? "top"
    : level._tag === "section"
      ? `section:${level.sectionId}`
      : `project:${level.projectId}`;

const tree = (bindings: ReadonlyArray<PoolBinding>): PoolTree => ({
  parentOf: (level) => parents.get(keyOf(level)) ?? null,
  bindings,
});
const personalAtTop: PoolBinding = { level: top, poolId: "personal", reach: "below" };

describe("poolChain", () => {
  it("walks from the home up to the top level", () => {
    expect(chainOf(tree([]), project("app")).map(keyOf)).toEqual([
      "project:app",
      "section:clients",
      "section:work",
      "top",
    ]);
  });

  it("runs on the nearest pool on the chain, whole", () => {
    const bindings = [
      personalAtTop,
      { level: section("work"), poolId: "work", reach: "below" },
    ] as const;
    expect(resolvePool(tree(bindings), project("app"))).toEqual({
      poolId: "work",
      from: section("work"),
    });
    expect(resolvePool(tree(bindings), project("notes"))).toEqual({
      poolId: "personal",
      from: top,
    });
    // A nearer one wins over both.
    expect(
      resolvePool(
        tree([...bindings, { level: project("app"), poolId: "lab", reach: "below" }]),
        project("app"),
      )?.poolId,
    ).toBe("lab");
  });

  it("serves a pool with reach here only at its own level", () => {
    const bindings = [
      personalAtTop,
      { level: section("work"), poolId: "work", reach: "here" },
    ] as const;
    expect(resolvePool(tree(bindings), section("work"))?.poolId).toBe("work");
    expect(resolvePool(tree(bindings), project("app"))?.poolId).toBe("personal");
  });

  it("finds no pool when the chain has none", () => {
    expect(resolvePool(tree([]), project("app"))).toBeNull();
    // A top-level pool that reaches only the top level doesn't cover folders below it.
    const hereOnly = [{ level: top, poolId: "personal", reach: "here" }] as const;
    expect(resolvePool(tree(hereOnly), project("app"))).toBeNull();
    expect(resolvePool(tree(hereOnly), top)?.poolId).toBe("personal");
  });

  it("stops at a cycle instead of spinning", () => {
    const looping: PoolTree = {
      parentOf: (level) => (keyOf(level) === "section:a" ? section("b") : section("a")),
      bindings: [],
    };
    expect(chainOf(looping, section("a")).map(keyOf)).toEqual(["section:a", "section:b"]);
  });
});
