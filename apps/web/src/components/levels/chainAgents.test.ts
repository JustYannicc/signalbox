import { describe, expect, it } from "vite-plus/test";

import { containerLevel } from "../multiplayer/containerScope";
import { HOME_SECTIONS } from "../sidebar/sections/sectionModel";
import { chainAgents } from "./chainAgents";
import { buildLevelOptions } from "./levelOptions";
import { TOP_LEVEL } from "./levels";

const placement = { projectSectionOverrides: {} };
const options = buildLevelOptions({
  sections: HOME_SECTIONS,
  projects: [],
  placement: { ...placement, names: {} },
});
const agentsFrom = (containerId: string) =>
  chainAgents(containerLevel(containerId), options, placement).map((option) => [
    option.agentName,
    option.label,
  ]);

describe("chainAgents from a container", () => {
  it("offers the container's agent, then each one above, nearest first, ending at the top", () => {
    expect(agentsFrom("terminal-app")).toEqual([
      ["terminal-app agent", "Work › Northwind team › terminal-app"],
      ["Northwind agent", "Work › Northwind team"],
      ["Work agent", "Work"],
      [null, "Top level"],
    ]);
  });

  it("reads a team as its section and container keys as themselves", () => {
    expect(agentsFrom("northwind")).toEqual(agentsFrom("section:work-northwind"));
    expect(agentsFrom("personal")).toEqual([
      ["Personal agent", "Personal"],
      [null, "Top level"],
    ]);
  });

  it("offers only the top level's agent from the top", () => {
    expect(containerLevel("home")).toBe(TOP_LEVEL);
    expect(agentsFrom("home")).toEqual([[null, "Top level"]]);
  });
});
