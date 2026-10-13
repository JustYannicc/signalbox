import { describe, expect, it } from "vite-plus/test";

import { ASK_UPS, asksFor, loanState } from "./askUp";
import { askLevel, levelChain, TOP_LEVEL } from "./levels";
import { levelAgentPeople, levelTeam } from "./levelSharing";

describe("asking up", () => {
  it("asks the lowest agent above the asker that covers the thing", () => {
    for (const ask of ASK_UPS) {
      expect(levelChain(ask.from).slice(1)).toContain(ask.to);
      expect(ask.to).toBe(askLevel(ask.from, ask.where));
    }
  });

  it("shows an ask on both the asker's and the answerer's page", () => {
    const ids = (level: string) => asksFor(level).map((ask) => ask.id);
    expect(ids("section:work-northwind")).toEqual([
      "ask-board-deck",
      "ask-sentry",
      "ask-release-page",
    ]);
    expect(ids(TOP_LEVEL)).toEqual(["ask-board-deck", "ask-todoist", "ask-receipts", "ask-porto"]);
    expect(ids("team-project:merchant-portal")).toEqual(["ask-sentry"]);
  });

  it("ends a loan with its task, or sooner when you end it", () => {
    const active = ASK_UPS.find((ask) => ask.id === "ask-sentry")!;
    const done = ASK_UPS.find((ask) => ask.id === "ask-release-page")!;
    expect(loanState(active, false)).toBe("active");
    expect(loanState(active, true)).toBe("ended-early");
    expect(loanState(done, false)).toBe("expired");
  });
});

describe("levelTeam", () => {
  it("shares agents of team levels with the team and keeps personal ones yours", () => {
    expect(levelTeam("section:work-northwind")?.id).toBe("northwind");
    expect(levelTeam("team-project:terminal-app")?.id).toBe("northwind");
    expect(levelTeam("section:work")).toBeNull();
    expect(levelTeam("section:personal")).toBeNull();
    expect(levelTeam(TOP_LEVEL)).toBeNull();
    expect(levelAgentPeople("team-project:merchant-portal").length).toBeGreaterThan(1);
  });
});
