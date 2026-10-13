import { describe, expect, it } from "vite-plus/test";

import { TOP_LEVEL } from "../levels/levels";
import type { AccountPool, PoolAccount, PoolHarness } from "./accountPoolsModel";
import { routeFor, routesFor } from "./poolRouting";

const PERSONAL = "section:personal";
const NORTHWIND = "section:work-northwind";
const MERCHANT_PORTAL = "team-project:merchant-portal";
const TERMINAL_APP = "team-project:terminal-app";

function pool(id: string, harness: PoolHarness, ...levels: string[]): AccountPool {
  const account: PoolAccount = {
    id: `${id}-account`,
    harness,
    name: id,
    plan: "Pro",
    levels,
    state: "active",
    windows: [],
    resetCredits: { availableCount: 0 },
    pin: { serverId: "zrh-1" },
  };
  return { id, name: id, harness, ownerId: "you", accounts: [account], grants: [] };
}

const POOLS = [
  pool("your codex", "codex", TOP_LEVEL),
  pool("northwind codex", "codex", NORTHWIND),
  pool("merchant-portal codex", "codex", MERCHANT_PORTAL),
  pool("your claude", "claude", TOP_LEVEL),
  pool("northwind claude", "claude", NORTHWIND),
];

const summary = (level: string, harness: PoolHarness, pools = POOLS) => {
  const route = routeFor(level, harness, pools);
  return {
    pools: route.pools.map((entry) => entry.id),
    from: route.from,
    inherited: route.inherited,
  };
};

describe("routeFor", () => {
  it("uses a project's own pool over its section's", () => {
    expect(summary(MERCHANT_PORTAL, "codex")).toEqual({
      pools: ["merchant-portal codex"],
      from: MERCHANT_PORTAL,
      inherited: false,
    });
  });

  it("inherits the section's pool when the project has none", () => {
    expect(summary(TERMINAL_APP, "codex")).toEqual({
      pools: ["northwind codex"],
      from: NORTHWIND,
      inherited: true,
    });
    // A project with its own Codex pool still inherits Claude from its section.
    expect(summary(MERCHANT_PORTAL, "claude").from).toBe(NORTHWIND);
  });

  it("falls back up to the top level, never sideways", () => {
    expect(summary(PERSONAL, "codex")).toEqual({
      pools: ["your codex"],
      from: TOP_LEVEL,
      inherited: true,
    });
    expect(summary(PERSONAL, "codex", [pool("northwind codex", "codex", NORTHWIND)])).toEqual({
      pools: [],
      from: null,
      inherited: false,
    });
  });

  it("combines every pool sitting at the winning level", () => {
    const pools = [...POOLS, pool("second northwind codex", "codex", NORTHWIND)];
    expect(summary(TERMINAL_APP, "codex", pools).pools).toEqual([
      "northwind codex",
      "second northwind codex",
    ]);
  });
});

describe("routesFor", () => {
  it("skips harnesses with no usable pool", () => {
    expect(
      routesFor(TERMINAL_APP, ["codex", "claude", "grok"], POOLS).map((r) => r.harness),
    ).toEqual(["codex", "claude"]);
  });
});
