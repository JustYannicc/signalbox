import { describe, expect, it } from "@effect/vitest";

import { navigationPanelCopy } from "./panel-copy";

describe("the navigation panel's name", () => {
  it("keeps the sections wording where no environment has folders", () => {
    expect(navigationPanelCopy({ withFolders: 0, total: 2 })).toMatchObject({
      title: "Sections",
      show: "Browse sections",
    });
  });

  it("says folders where every environment has them", () => {
    expect(navigationPanelCopy({ withFolders: 2, total: 2 })).toEqual({
      title: "Folders",
      subtitle: "Choose a folder to show its threads.",
      show: "Browse folders",
      hide: "Hide folders",
    });
  });

  it("uses words that fit both while they're mixed", () => {
    const copy = navigationPanelCopy({ withFolders: 1, total: 2 });
    expect(Object.values(copy).join(" ")).not.toMatch(/section|project|context/i);
  });
});
