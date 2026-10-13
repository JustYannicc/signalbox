import { describe, expect, it } from "vite-plus/test";

import { HOME_SECTIONS } from "../sidebar/sections/sectionModel";
import { agentAccess, inheritedAt, placedAt } from "./levelAccess";
import { buildLevelOptions } from "./levelOptions";
import { askLevelAny, canUse, nearestOnChain, TOP_LEVEL } from "./levels";

const WORK = "section:work";
const NORTHWIND = "section:work-northwind";
const PERSONAL = "section:personal";
const TERMINAL_APP = "team-project:terminal-app";

const thing = (name: string, ...levels: string[]) => ({ name, levels });
const reaching = (name: string, ...levels: string[]) => ({ name, levels, reach: "below" as const });
const names = (things: readonly { name: string }[]) => things.map((entry) => entry.name);

const THINGS = [
  thing("work gmail", NORTHWIND),
  thing("personal gmail", PERSONAL),
  thing("work wiki", WORK),
  thing("neptune skill", TERMINAL_APP),
  thing("todoist", TOP_LEVEL),
  thing("shared skill", NORTHWIND, PERSONAL),
  thing("unplaced"),
];

describe("agentAccess", () => {
  it("lets a section agent use what levels.ts allows and leaves out unplaced things", () => {
    const access = agentAccess(PERSONAL, THINGS);
    expect(names(access.usable)).toEqual(["personal gmail", "shared skill"]);
    const asked = access.asks.flatMap((ask) => names(ask.things));
    expect(asked).not.toContain("unplaced");
    expect(asked).toHaveLength(THINGS.length - 3);
  });

  it("names the nearest agent to ask, nearest first", () => {
    const access = agentAccess(NORTHWIND, THINGS);
    expect(names(access.usable)).toContain("work gmail");
    expect(access.asks.map((ask) => ask.level)).toEqual([WORK, TOP_LEVEL]);
    expect(names(access.asks[0]?.things ?? [])).toEqual(["work wiki"]);
    expect(names(access.asks[1]?.things ?? [])).toEqual(["personal gmail", "todoist"]);
  });

  it("lets the top-level agent use everything placed", () => {
    const access = agentAccess(TOP_LEVEL, THINGS);
    expect(access.usable).toHaveLength(THINGS.length - 1);
    expect(access.asks).toEqual([]);
  });
});

describe("askLevelAny", () => {
  it("picks the nearest agent among a thing's levels", () => {
    // From a Northwind project: Personal needs the top level, Work is nearer.
    expect(askLevelAny(TERMINAL_APP, [PERSONAL, WORK])).toBe(WORK);
  });

  it("is null when the agent can already use it, or it sits nowhere", () => {
    expect(askLevelAny(PERSONAL, [NORTHWIND, PERSONAL])).toBeNull();
    expect(askLevelAny(PERSONAL, [])).toBeNull();
  });
});

describe("placedAt", () => {
  it("matches the exact level only", () => {
    expect(names(placedAt(THINGS, NORTHWIND))).toEqual(["work gmail", "shared skill"]);
  });
});

describe("buildLevelOptions", () => {
  const options = buildLevelOptions({
    sections: HOME_SECTIONS,
    projects: [
      { projectKey: "env:t3code", displayName: "t3code", workspaceRoot: "/code/t3code" },
      {
        projectKey: "env:northwind-api",
        displayName: "northwind-api",
        workspaceRoot: "/code/northwind-api",
      },
    ],
    placement: { projectSectionOverrides: {}, names: {} },
  });
  const byKey = new Map(options.map((option) => [option.key, option]));

  it("lists the top level first, then the tree with folder paths", () => {
    expect(options[0]?.key).toBe(TOP_LEVEL);
    expect(byKey.get(TERMINAL_APP)?.label).toBe("Work › Northwind team › terminal-app");
    expect(byKey.get("project:env:t3code")?.label).toBe("Personal › t3code");
    expect(byKey.get("project:env:northwind-api")?.label).toBe(
      "Work › Northwind team › northwind-api",
    );
  });

  it("gives each level the agent id the Home tree opens", () => {
    expect(byKey.get(NORTHWIND)?.agentId).toBe("section-northwind");
    expect(byKey.get(TERMINAL_APP)?.agentId).toBe("project-terminal-app");
    expect(byKey.get("project:env:t3code")?.agentId).toBe("project-t3code");
  });

  it("follows a project moved to another section", () => {
    const moved = buildLevelOptions({
      sections: HOME_SECTIONS,
      projects: [],
      placement: { projectSectionOverrides: { [TERMINAL_APP]: "personal" }, names: {} },
    });
    expect(moved.find((option) => option.key === TERMINAL_APP)?.label).toBe(
      "Personal › terminal-app",
    );
  });
});

describe("reach", () => {
  it("keeps things above out of sight unless they reach below", () => {
    expect(canUse(TERMINAL_APP, NORTHWIND)).toBe(false);
    expect(canUse(TERMINAL_APP, NORTHWIND, undefined, "below")).toBe(true);
    // Reaching below never crosses into a sibling branch.
    expect(canUse(PERSONAL, NORTHWIND, undefined, "below")).toBe(false);
  });

  it("sorts a thing reaching below into usable for folders inside, and nowhere else", () => {
    const things = [
      reaching("northwind slack", NORTHWIND),
      thing("northwind jira", NORTHWIND),
      reaching("personal notes", PERSONAL),
    ];
    const access = agentAccess(TERMINAL_APP, things);
    expect(names(access.usable)).toEqual(["northwind slack"]);
    // The rest still needs an ask: Northwind's agent for its Jira, the top for Personal.
    expect(access.asks.map((ask) => ask.level)).toEqual([NORTHWIND, TOP_LEVEL]);
    expect(names(access.asks[0]?.things ?? [])).toEqual(["northwind jira"]);
    expect(names(access.asks[1]?.things ?? [])).toEqual(["personal notes"]);
  });

  it("lists what a level inherits apart from what sits there, with its nearest source", () => {
    const things = [
      reaching("work wiki", WORK),
      reaching("northwind slack", NORTHWIND, WORK),
      thing("northwind jira", NORTHWIND),
      reaching("neptune skill", TERMINAL_APP),
      reaching("personal notes", PERSONAL),
    ];
    const inherited = inheritedAt(things, TERMINAL_APP);
    expect(inherited.map((entry) => [entry.thing.name, entry.from])).toEqual([
      ["work wiki", WORK],
      ["northwind slack", NORTHWIND],
    ]);
    // What sits at the level itself isn't inherited, even when it reaches below.
    expect(inheritedAt(things, NORTHWIND).map((entry) => entry.thing.name)).toEqual(["work wiki"]);
  });

  it("lets the lowest level win for pools", () => {
    expect(nearestOnChain(TERMINAL_APP, [TOP_LEVEL, NORTHWIND])).toBe(NORTHWIND);
    expect(nearestOnChain(TERMINAL_APP, [TOP_LEVEL, NORTHWIND, TERMINAL_APP])).toBe(TERMINAL_APP);
    expect(nearestOnChain(PERSONAL, [NORTHWIND])).toBeNull();
  });
});
