import { describe, expect, it } from "vite-plus/test";

import { buildLevelOptions } from "../levels/levelOptions";
import { TOP_LEVEL } from "../levels/levels";
import { HOME_SECTIONS } from "../sidebar/sections/sectionModel";
import {
  agentLevel,
  demoNotifyOverrides,
  migrateNotifyOverrides,
  resolveNotifyPolicy,
} from "./notificationPolicy";

const PERSONAL = "section:personal";
const WORK = "section:work";
const NORTHWIND = "section:work-northwind";
const TERMINAL_APP = "team-project:terminal-app";
const PERSONAL_PROJECT = "project:env:dotfiles";

const placement = { projectSectionOverrides: { "env:dotfiles": "personal" } };
const resolve = (level: string, overrides: Record<string, "all" | "important" | "none">) =>
  resolveNotifyPolicy(level, overrides, "important", placement);

describe("resolveNotifyPolicy", () => {
  it("lets a rule at a section hold for its projects", () => {
    expect(resolve(PERSONAL_PROJECT, { [PERSONAL]: "none" })).toEqual({
      policy: "none",
      from: PERSONAL,
    });
  });

  it("prefers the nearest rule: a project's own beats its section's", () => {
    const overrides = { [WORK]: "none", [TERMINAL_APP]: "all" } as const;
    expect(resolve(TERMINAL_APP, overrides).policy).toBe("all");
    expect(resolve(NORTHWIND, overrides)).toEqual({ policy: "none", from: WORK });
  });

  it("falls back to the default off the chain", () => {
    expect(resolve(TERMINAL_APP, { [PERSONAL]: "none" })).toEqual({
      policy: "important",
      from: null,
    });
    expect(resolve(PERSONAL, { [TOP_LEVEL]: "all" }).from).toBe(TOP_LEVEL);
  });
});

describe("migrateNotifyOverrides", () => {
  const options = buildLevelOptions({
    sections: HOME_SECTIONS,
    projects: [],
    placement: { projectSectionOverrides: {}, names: {} },
  });
  const levelOf = (agentKey: string) => agentLevel(agentKey, options);

  it("re-keys agent ids to their levels and keeps unknown agents as they are", () => {
    expect(
      migrateNotifyOverrides(
        {
          assistant: "all",
          "section-personal": "none",
          "project-terminal-app": "important",
          "workflow-expenses": "none",
        },
        levelOf,
      ),
    ).toEqual({
      [TOP_LEVEL]: "all",
      [PERSONAL]: "none",
      [TERMINAL_APP]: "important",
      "workflow-expenses": "none",
    });
  });

  it("lets a rule already set at the level win over an older agent entry", () => {
    expect(migrateNotifyOverrides({ [WORK]: "all", "section-work": "none" }, levelOf)).toEqual({
      [WORK]: "all",
    });
  });
});

describe("demoNotifyOverrides", () => {
  const optionsWith = (names: readonly string[]) =>
    buildLevelOptions({
      sections: HOME_SECTIONS,
      projects: names.map((name) => ({
        projectKey: `env:${name}`,
        displayName: name,
        workspaceRoot: `/code/${name}`,
      })),
      placement: { projectSectionOverrides: {}, names: {} },
    });

  it("mutes Personal and keeps signalbox pinging, never a Northwind project", () => {
    expect(demoNotifyOverrides(optionsWith(["dotfiles", "northwind-tools", "signalbox"]))).toEqual({
      [PERSONAL]: "none",
      "project:env:signalbox": "important",
    });
    expect(demoNotifyOverrides(optionsWith([]))).toEqual({ [PERSONAL]: "none" });
  });
});
