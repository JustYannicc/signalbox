import { describe, expect, it } from "vite-plus/test";

import { levelChain, TOP_LEVEL } from "../levels/levels";
import { childLevels, costAt, levelPath, rollUpCosts, type CostEntry } from "./levelCosts";

const WORK = "section:work";
const NORTHWIND = "section:work-northwind";
const PERSONAL = "section:personal";
const MERCHANT_PORTAL = "team-project:merchant-portal";
const TERMINAL_APP = "team-project:terminal-app";

const NO_MOVES = { projectSectionOverrides: {} };
const chainOf = (level: string) => levelChain(level, NO_MOVES);

const spend = (
  id: string,
  level: string,
  usd: number,
  paidBy: string | null = null,
): CostEntry => ({
  id,
  kind: "thread",
  label: id,
  level,
  harness: "codex",
  usd,
  paidBy,
});

const ENTRIES = [
  spend("appa", TOP_LEVEL, 8, "yours"),
  spend("okr draft", WORK, 3, "yours"),
  spend("rollout chat", NORTHWIND, 1, "northwind"),
  spend("refund webhooks", MERCHANT_PORTAL, 18, "merchant-portal"),
  spend("payout copy", MERCHANT_PORTAL, 4, "northwind"),
  spend("printer fix", TERMINAL_APP, 10, "northwind"),
  spend("tax return", PERSONAL, 5, "yours"),
];

describe("rollUpCosts", () => {
  const costs = rollUpCosts(ENTRIES, chainOf);

  it("gives each level what sits there plus everything inside it", () => {
    expect(costAt(costs, MERCHANT_PORTAL)).toMatchObject({ totalUsd: 22, ownUsd: 22 });
    expect(costAt(costs, NORTHWIND)).toMatchObject({ totalUsd: 33, ownUsd: 1 });
    expect(costAt(costs, WORK)).toMatchObject({ totalUsd: 36, ownUsd: 3 });
    expect(costAt(costs, PERSONAL)).toMatchObject({ totalUsd: 5, ownUsd: 5 });
    expect(costAt(costs, TOP_LEVEL)).toMatchObject({ totalUsd: 49, ownUsd: 8 });
  });

  it("keeps a sibling's spend out of a level", () => {
    expect(costAt(costs, TERMINAL_APP).totalUsd).toBe(10);
  });

  it("splits a level's total by the pool that paid, everything inside included", () => {
    expect(Object.fromEntries(costAt(costs, NORTHWIND).byPool)).toEqual({
      northwind: 15,
      "merchant-portal": 18,
    });
  });

  it("reports nothing for a level with no spend", () => {
    expect(costAt(costs, "section:nowhere")).toMatchObject({ totalUsd: 0, ownUsd: 0 });
  });

  it("follows a project moved to another section", () => {
    const moved = { projectSectionOverrides: { [MERCHANT_PORTAL]: "personal" } };
    const after = rollUpCosts(ENTRIES, (level) => levelChain(level, moved));
    expect(costAt(after, PERSONAL).totalUsd).toBe(27);
    expect(costAt(after, NORTHWIND).totalUsd).toBe(11);
  });
});

describe("childLevels and levelPath", () => {
  const levels = [TOP_LEVEL, WORK, NORTHWIND, MERCHANT_PORTAL, TERMINAL_APP, PERSONAL].map(
    (key) => ({ key }),
  );

  it("lists only the levels directly inside, in the given order", () => {
    expect(childLevels(TOP_LEVEL, levels, chainOf).map((level) => level.key)).toEqual([
      WORK,
      PERSONAL,
    ]);
    expect(childLevels(NORTHWIND, levels, chainOf).map((level) => level.key)).toEqual([
      MERCHANT_PORTAL,
      TERMINAL_APP,
    ]);
  });

  it("walks from the top down to a level", () => {
    expect(levelPath(TERMINAL_APP, chainOf)).toEqual([TOP_LEVEL, WORK, NORTHWIND, TERMINAL_APP]);
  });
});
