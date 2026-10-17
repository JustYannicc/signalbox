import { describe, expect, it } from "vite-plus/test";

import { folderPhaseEdit, folderPhaseTemplateText } from "./folderPhasesModel.ts";

const before = { phases: ["Idea", "Doing", "Done"], current: "Doing" };

describe("folderPhaseEdit", () => {
  it("keeps the current phase when it's still listed, wherever it moved", () => {
    expect(folderPhaseEdit(before, "Done\n doing \n\nIdea")).toEqual({
      phases: ["Done", "doing", "Idea"],
      current: "doing",
      problem: null,
      status: "Now in doing.",
      unchanged: false,
    });
    expect(folderPhaseEdit(before, "Idea\nDoing\nDone\n").unchanged).toBe(true);
  });

  it("follows a renamed current phase by its line, else starts at the first", () => {
    expect(folderPhaseEdit(before, "Idea\nBuilding\nDone").current).toBe("Building");
    expect(folderPhaseEdit(before, "Idea\nDone").current).toBe("Idea");
    expect(folderPhaseEdit(undefined, folderPhaseTemplateText("organization")).current).toBe(
      "Proposal",
    );
  });

  it("says why a list can't be saved", () => {
    expect(folderPhaseEdit(before, "  \n").problem).not.toBeNull();
    expect(folderPhaseEdit(before, "Beta\nbeta").problem).toBe("Each phase needs its own name.");
  });
});
