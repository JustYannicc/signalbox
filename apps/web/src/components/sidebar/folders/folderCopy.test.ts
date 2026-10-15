import { describe, expect, it } from "vite-plus/test";

import { draftHeroCopy, PROJECT_HERO_COPY, projectSettingsLabel } from "./folderCopy";

describe("draftHeroCopy", () => {
  it("keeps upstream's project words where the environment has no folders", () => {
    expect(draftHeroCopy(null)).toBe(PROJECT_HERO_COPY);
  });

  it("names the level a thread without a project starts in, and never says project", () => {
    const copy = draftHeroCopy("Personal");
    expect(copy.scratchLabel).toBe("Personal");
    expect(copy.startWithout).toBe("or start in Personal");
    for (const text of Object.values(copy)) expect(text).not.toMatch(/project/i);
  });
});

describe("projectSettingsLabel", () => {
  it("calls a thread's project its files where the environment keeps folders", () => {
    expect(projectSettingsLabel(true)).toBe("Files settings");
    expect(projectSettingsLabel(false)).toBe("Project settings");
  });
});
