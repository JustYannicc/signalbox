import { describe, expect, it } from "@effect/vitest";
import {
  diffNewBuiltinGaps,
  findBunCapabilityGaps,
  type BuiltinGap,
  type BuiltinCapabilityManifest,
  type BunCapabilityGap,
} from "./builtin-gap.ts";
import type { BunApiInventory } from "./bun-api-inventory.ts";

describe("release capability gaps", () => {
  it("applies Bun support to exact leaves and requires explicit host or feature-off evidence", () => {
    const inventory: BunApiInventory = {
      members: [
        {
          path: "spawn",
          occurrences: [{ module: "main.js", offset: 1, line: 1, column: 2, access: "call" }],
        },
        {
          path: "spawnSync",
          occurrences: [{ module: "main.js", offset: 2, line: 1, column: 3, access: "call" }],
        },
        {
          path: "runtimeHost",
          occurrences: [{ module: "main.js", offset: 3, line: 1, column: 4, access: "read" }],
        },
        {
          path: "headlessFeature",
          occurrences: [{ module: "main.js", offset: 4, line: 1, column: 5, access: "call" }],
        },
      ],
      dynamicAccesses: [],
    };
    const capabilities: BuiltinCapabilityManifest = {
      bunApis: {
        spawn: "implemented",
        spawnSync: "host",
        runtimeHost: "host",
        headlessFeature: "headless",
      },
      nodeBuiltins: {},
      providedHostPaths: ["spawnSync"],
      featureOffPaths: ["headlessFeature"],
    };

    expect(
      findBunCapabilityGaps(inventory, capabilities).map(({ name, reason }) => `${name}:${reason}`),
    ).toEqual(["runtimeHost:missing-host-binding", "headlessFeature:unguarded-unsupported-use"]);
    expect(
      findBunCapabilityGaps(inventory, {
        ...capabilities,
        providedHostPaths: ["spawnSync", "runtimeHost"],
      })[0]?.name,
    ).toBe("headlessFeature");
  });

  it("does not let guarded gaps hide missing capability evidence", () => {
    const guardedBun: BunCapabilityGap = {
      kind: "bun-api",
      name: "conditionalFeature",
      module: "main.js",
      key: "main",
      line: 2,
      column: 4,
      offset: 10,
      reason: "unmapped-api",
      guarded: true,
    };
    const unguardedBun: BunCapabilityGap = { ...guardedBun, name: "newFeature", guarded: false };
    const guardedNode: BuiltinGap = {
      kind: "node-builtin",
      name: "readFile",
      specifier: "node:fs",
      canonicalBuiltin: "fs",
      module: "main.js",
      key: "main",
      line: 3,
      column: 4,
      offset: 20,
      reason: "missing-named-export",
      guarded: true,
    };
    const missingFeatureOff: BunCapabilityGap = {
      ...guardedBun,
      name: "headlessFeature",
      reason: "missing-feature-off-evidence",
    };

    expect(diffNewBuiltinGaps([], [guardedBun, missingFeatureOff, guardedNode])).toEqual([
      guardedBun,
      missingFeatureOff,
    ]);
    expect(diffNewBuiltinGaps([], [{ ...guardedNode, guarded: false }])).toEqual([
      { ...guardedNode, guarded: false },
    ]);
    expect(diffNewBuiltinGaps([], [unguardedBun])).toEqual([unguardedBun]);
    expect(diffNewBuiltinGaps([guardedNode], [{ ...guardedNode, guarded: false }])).toEqual([
      { ...guardedNode, guarded: false },
    ]);
    expect(diffNewBuiltinGaps([{ ...guardedNode, guarded: false }], [guardedNode])).toEqual([]);
  });

  it("counts dynamic sites separately when comparing a release", () => {
    const dynamicNode: BuiltinGap = {
      kind: "node-builtin",
      name: "<dynamic>",
      specifier: "node:fs",
      canonicalBuiltin: "fs",
      module: "main.js",
      key: "main",
      line: 4,
      column: 5,
      offset: 40,
      reason: "dynamic-member",
      guarded: false,
    };
    const dynamicBun: BunCapabilityGap = {
      kind: "bun-api",
      name: "Bun.*",
      module: "main.js",
      key: "main",
      line: 5,
      column: 6,
      offset: 50,
      reason: "dynamic-access",
      guarded: false,
    };

    expect(
      diffNewBuiltinGaps(
        [dynamicNode, dynamicBun],
        [dynamicNode, dynamicNode, dynamicBun, dynamicBun],
      ),
    ).toEqual([dynamicNode, dynamicBun]);
  });
});
