import { describe, expect, it } from "vite-plus/test";

import { TOP_LEVEL } from "../../levels/levels";
import { TEAM_THREADS } from "../../multiplayer/multiplayerFixtures";
import { buildMappedIndex } from "../sections/mappedItems";
import { LOOSE_ITEMS } from "../sections/sectionModel";
import { breakthroughGroups, type HiddenContainer } from "./breakthrough";

const PERSONAL = "section:personal";
const TERMINAL_APP = "team-project:terminal-app";
const NORTHWIND = "section:work-northwind";

// The fixture rule: at terminal-app, approvals and failures break through Focus.
const mapped = buildMappedIndex({ automations: [], projects: [] });

function container(key: string, place: Partial<HiddenContainer["contents"]>): HiddenContainer {
  return {
    key,
    label: key,
    place: { containerKey: key, containerId: key, sharedContainer: true },
    contents: { loose: [], teamThreads: [], rooms: [], threads: [], mapped: [], ...place },
    threads: [],
    projectName: null,
  };
}

const hidden = [
  container(NORTHWIND, {
    loose: LOOSE_ITEMS.filter((item) => item.sectionId === "work-northwind"),
    mapped: mapped.byContainer.get(NORTHWIND) ?? [],
  }),
  container(TERMINAL_APP, {
    teamThreads: TEAM_THREADS.filter((thread) => thread.projectId === "terminal-app"),
    mapped: mapped.byContainer.get(TERMINAL_APP) ?? [],
  }),
];

const groups = (focused: string) =>
  breakthroughGroups({ containers: hidden, focused, lastVisited: {}, homeById: mapped.homeById });

describe("escalation breaking through Focus in the tree", () => {
  it("lets only what a rule names through, grouped by folder", () => {
    const [terminal, ...rest] = groups(PERSONAL);
    expect(rest).toEqual([]);
    expect(terminal?.key).toBe(TERMINAL_APP);
    expect(terminal?.contents.teamThreads.map((thread) => thread.id).toSorted()).toEqual([
      "ta-neptune-questions",
      "ta-printer-fix",
    ]);
    // The failing Sentry place lives there; the Drive referenced from Northwind team doesn't count.
    expect(terminal?.contents.mapped.map((item) => item.id)).toEqual(["place:sentry-terminal-app"]);
    expect(terminal?.rollup.needsYou).toBe(3);
  });

  it("shows nothing under All, where nothing is hidden", () => {
    expect(groups(TOP_LEVEL)).toEqual([]);
  });
});
