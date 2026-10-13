import { describe, expect, it } from "vite-plus/test";

import { AUTOMATIONS } from "../../homeAutomations/automationFixtures";
import { TOP_LEVEL } from "../../levels/levels";
import {
  hiddenRootSectionIds,
  isInSight,
  isLevelInFocus,
  isSectionInFocus,
  liveFocusedLevel,
} from "./focusLevels";
import { migrateFocus } from "./focusStore";
import { automationAttentionInFocus } from "./needsYouInFocus";

const WORK = "section:work";
const NORTHWIND = "section:work-northwind";
const PERSONAL = "section:personal";
const TERMINAL_APP = "team-project:terminal-app";

describe("Focus as a level view", () => {
  it("shows everything at the top level", () => {
    for (const level of [WORK, NORTHWIND, PERSONAL, TERMINAL_APP]) {
      expect(isLevelInFocus(level, TOP_LEVEL)).toBe(true);
    }
    expect(hiddenRootSectionIds(TOP_LEVEL)).toEqual([]);
  });

  it("hides every other subtree, including what's nested in it", () => {
    expect(isLevelInFocus(PERSONAL, PERSONAL)).toBe(true);
    expect(isLevelInFocus(WORK, PERSONAL)).toBe(false);
    expect(isLevelInFocus(NORTHWIND, PERSONAL)).toBe(false);
    expect(isLevelInFocus(TERMINAL_APP, PERSONAL)).toBe(false);
    expect(hiddenRootSectionIds(PERSONAL)).toEqual(["work"]);
    expect(hiddenRootSectionIds(WORK)).toEqual(["personal"]);
  });

  it("keeps the levels above a focused subsection in sight, and the top level always", () => {
    expect(isLevelInFocus(TERMINAL_APP, NORTHWIND)).toBe(true);
    expect(isLevelInFocus(WORK, NORTHWIND)).toBe(true);
    expect(isLevelInFocus(PERSONAL, NORTHWIND)).toBe(false);
    expect(isSectionInFocus(null, PERSONAL)).toBe(true);
    expect(isLevelInFocus(TOP_LEVEL, PERSONAL)).toBe(true);
  });

  it("falls back to All when the focused section is gone", () => {
    expect(liveFocusedLevel("section:deleted")).toBe(TOP_LEVEL);
    expect(isLevelInFocus(WORK, "section:deleted")).toBe(true);
  });

  it("keeps a many-level thing in sight when any of its levels is", () => {
    expect(isInSight({ levels: [WORK, PERSONAL] }, PERSONAL)).toBe(true);
    expect(isInSight({ levels: [WORK, NORTHWIND] }, PERSONAL)).toBe(false);
    expect(isInSight({ levels: [] }, PERSONAL)).toBe(true);
  });

  it("migrates the old modes to levels", () => {
    expect(migrateFocus({ mode: "personal", setByRuleId: "time" }, 1)).toEqual({
      focusedLevel: PERSONAL,
      setByRuleId: "time",
    });
    expect(migrateFocus({ mode: "all" }, 1).focusedLevel).toBe(TOP_LEVEL);
  });
});

describe("automation needs-you under Focus", () => {
  const ids = (focused: string, projectHome?: string) =>
    automationAttentionInFocus({
      automations: AUTOMATIONS,
      projects: [
        { projectKey: "env:northwind", displayName: "northwind-portal", workspaceRoot: "/x" },
      ],
      overrides: {
        homes: projectHome ? { "automation:danger-check": projectHome } : {},
        references: {},
        reach: {},
      },
      projectSectionOverrides: {},
      focused,
    }).map((item) => item.automation.id);

  it("counts every run at the top level", () => {
    expect(ids(TOP_LEVEL)).toEqual(expect.arrayContaining(["customer-replies", "notion-digest"]));
  });

  it("leaves out runs homed at Work while Personal is in focus", () => {
    const personal = ids(PERSONAL);
    expect(personal).toContain("danger-check");
    expect(personal).not.toContain("customer-replies");
    expect(personal).not.toContain("notion-digest");
  });

  it("judges a project home by the section the project sits in", () => {
    expect(ids(PERSONAL, "project:env:northwind")).not.toContain("danger-check");
    expect(ids(WORK, "project:env:northwind")).toContain("danger-check");
  });
});
