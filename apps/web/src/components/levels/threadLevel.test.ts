import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isInSight } from "../sidebar/focus/focusLevels";
import { registerProjectRoots, TOP_LEVEL } from "./levels";
import { threadLevels } from "./threadLevel";

const env = "env-1" as EnvironmentId;
const project = {
  environmentId: env,
  id: "p-merchant" as ProjectId,
  title: "merchant-portal",
  workspaceRoot: "/repos/northwind/merchant-portal",
};
const none = { itemContainers: {}, projectSectionOverrides: {} };
const thread = (id: string, rootThreadId = id) => ({
  environmentId: env,
  id: id as ThreadId,
  lineage: { rootThreadId: rootThreadId as ThreadId },
});

describe("threadLevels", () => {
  it("puts a thread at its project, judged by the project's section for Focus", () => {
    expect(threadLevels(thread("t1"), project, none)).toEqual({
      level: `project:${env}:p-merchant`,
      focusLevel: "section:work-northwind",
    });
  });

  it("uses the Home tree's project key once the tree registered the folder", () => {
    registerProjectRoots(new Map([[project.workspaceRoot, "merchant-group"]]));
    expect(threadLevels(thread("t1"), project, none).level).toBe("project:merchant-group");
  });

  it("follows a Home move, and a subagent inherits its root thread's level", () => {
    const placement = {
      itemContainers: { [`${env}:root-thread`]: "section:work" },
      projectSectionOverrides: {},
    };
    expect(threadLevels(thread("root-thread"), project, placement).level).toBe("section:work");
    expect(threadLevels(thread("grandchild", "root-thread"), project, placement)).toEqual({
      level: "section:work",
      focusLevel: "section:work",
    });
  });

  it("keeps a Work subagent out of sight under Personal Focus", () => {
    const { focusLevel } = threadLevels(thread("child", "t1"), project, none);
    expect(isInSight({ levels: [focusLevel] }, "section:personal")).toBe(false);
    expect(isInSight({ levels: [focusLevel] }, TOP_LEVEL)).toBe(true);
  });
});
