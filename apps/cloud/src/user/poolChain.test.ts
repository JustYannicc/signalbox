import { FolderId, type FolderLevel } from "@t3tools/contracts/signalboxFolders";
import { describe, expect, it } from "@effect/vitest";

import { chainOf, type PoolTree, resolvePool } from "./poolChain.ts";
import type { PoolBinding } from "./ResourceBindings.ts";

const top: FolderLevel = { _tag: "top" };
const folder = (id: string): FolderLevel => ({ _tag: "folder", folderId: FolderId.make(id) });

/** Personal at the top; Work under it, Clients under Work; the app in Clients, notes loose. */
const parents = new Map<string, FolderLevel | null>([
  ["top", null],
  ["work", top],
  ["clients", folder("work")],
  ["app", folder("clients")],
  ["notes", top],
]);
const keyOf = (level: FolderLevel) => (level._tag === "top" ? "top" : level.folderId);

const tree = (bindings: ReadonlyArray<PoolBinding>): PoolTree => ({
  parentOf: (level) => parents.get(keyOf(level)) ?? null,
  bindings,
});
const personalAtTop: PoolBinding = { level: top, poolId: "personal", reach: "below" };

describe("poolChain", () => {
  it("walks from the home up to the top level", () => {
    expect(chainOf(tree([]), folder("app")).map(keyOf)).toEqual(["app", "clients", "work", "top"]);
  });

  it("runs on the nearest pool on the chain, whole", () => {
    const bindings = [
      personalAtTop,
      { level: folder("work"), poolId: "work", reach: "below" },
    ] as const;
    expect(resolvePool(tree(bindings), folder("app"))).toEqual({
      poolId: "work",
      from: folder("work"),
    });
    expect(resolvePool(tree(bindings), folder("notes"))).toEqual({
      poolId: "personal",
      from: top,
    });
    // A nearer one wins over both.
    expect(
      resolvePool(
        tree([...bindings, { level: folder("app"), poolId: "lab", reach: "below" }]),
        folder("app"),
      )?.poolId,
    ).toBe("lab");
  });

  it("serves a pool with reach here only at its own level", () => {
    const bindings = [
      personalAtTop,
      { level: folder("work"), poolId: "work", reach: "here" },
    ] as const;
    expect(resolvePool(tree(bindings), folder("work"))?.poolId).toBe("work");
    expect(resolvePool(tree(bindings), folder("app"))?.poolId).toBe("personal");
  });

  it("finds no pool when the chain has none", () => {
    expect(resolvePool(tree([]), folder("app"))).toBeNull();
    // A top-level pool that reaches only the top level doesn't cover folders below it.
    const hereOnly = [{ level: top, poolId: "personal", reach: "here" }] as const;
    expect(resolvePool(tree(hereOnly), folder("app"))).toBeNull();
    expect(resolvePool(tree(hereOnly), top)?.poolId).toBe("personal");
  });

  it("stops at a cycle instead of spinning", () => {
    const looping: PoolTree = {
      parentOf: (level) => (keyOf(level) === "a" ? folder("b") : folder("a")),
      bindings: [],
    };
    expect(chainOf(looping, folder("a")).map(keyOf)).toEqual(["a", "b"]);
  });
});
