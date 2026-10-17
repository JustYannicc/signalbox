import { describe, expect, it } from "vite-plus/test";

import { draftHeroCopy, PROJECT_HERO_COPY, projectSettingsLabel } from "./folderCopy";

describe("draftHeroCopy", () => {
  it("keeps upstream's project words where the environment has no folders", () => {
    expect(draftHeroCopy(false)).toBe(PROJECT_HERO_COPY);
  });

  it("starts a thread without a project at the top level, and never says project", () => {
    const copy = draftHeroCopy(true);
    expect(copy.scratchLabel).toBe("Top level");
    expect(copy.startWithout).toBe("or start at the top level");
    for (const text of Object.values(copy)) expect(text).not.toMatch(/project/i);
  });
});

describe("projectSettingsLabel", () => {
  it("calls a thread's project its files where the environment keeps folders", () => {
    expect(projectSettingsLabel(true)).toBe("Files settings");
    expect(projectSettingsLabel(false)).toBe("Project settings");
  });
});
