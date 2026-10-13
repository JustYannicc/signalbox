import { describe, expect, it } from "vite-plus/test";

import { ASKS, CONTEXTS } from "./topLayerFixtures";
import { buildQueue, type Intent } from "./topLayerQueue";

const queue = (intent: Intent, answered: readonly string[] = []) =>
  buildQueue({
    contexts: CONTEXTS,
    asks: ASKS,
    isOpen: (ask) => !answered.includes(ask.id),
    intent,
  });

const names = (intent: Intent, answered?: readonly string[]) =>
  queue(intent, answered).turns.map((turn) => turn.context.id);

describe("buildQueue", () => {
  it("puts the soonest real deadline first, then what unblocks the most", () => {
    expect(names("all")).toEqual(["terminal-app", "thesis", "northwind-checkout", "flat-move"]);
  });

  it("lets a deadline through an intent that doesn't fit, and says why", () => {
    const personal = queue("personal");
    expect(personal.turns.map((turn) => turn.context.id)).toEqual([
      "terminal-app",
      "thesis",
      "flat-move",
    ]);
    expect(personal.turns[0]?.exceptBecause).toBe("closes 22:00");
    expect(personal.heldBack.map((context) => context.id)).toEqual(["northwind-checkout"]);
  });

  it("drops answered asks and reorders once a deadline is handled", () => {
    expect(names("all", ["terminal-release"])).toEqual([
      "thesis",
      "northwind-checkout",
      "flat-move",
    ]);
  });

  it("counts time only for what's still open", () => {
    expect(queue("all").minutes).toBe(14);
    expect(queue("all", ["checkout-stripe"]).minutes).toBe(11);
  });
});
