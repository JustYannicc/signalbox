import { describe, expect, it } from "@effect/vitest";

import { projectMoveMenuActions, sectionMenuActions } from "./section-navigation-model";

const snapshot = {
  revision: 1,
  sections: [
    { id: "a", name: "A", parentId: null, position: 0 },
    { id: "x", name: "X", parentId: "a", position: 0 },
    { id: "b", name: "B", parentId: "x", position: 0 },
    { id: "c", name: "C", parentId: "b", position: 0 },
    { id: "d", name: "D", parentId: null, position: 1 },
  ],
  projectPlacements: [],
} as const;

describe("mobile section parent choices", () => {
  it("allows only parents that cannot create a cycle", () => {
    const move = sectionMenuActions({
      section: snapshot.sections[2],
      snapshot,
    }).find((action) => action.id === "section:move");

    expect(move?.subactions?.map((action) => action.id)).toEqual([
      "section:parent:root",
      "section:parent:a",
      "section:parent:d",
    ]);
  });

  it("uses visible sibling bounds for project reordering and preserves the current parent", () => {
    const rootActions = projectMoveMenuActions({
      snapshot,
      sectionId: null,
      siblingIndex: 0,
      siblingCount: 2,
    });
    const rootDestinations = rootActions[0]?.subactions ?? [];
    expect(rootActions.map((action) => action.id)).toEqual(["project:move", "project:down"]);
    expect(rootDestinations.find((action) => action.id === "project:root")?.state).toBe("on");

    const childActions = projectMoveMenuActions({
      snapshot,
      sectionId: snapshot.sections[1]!.id,
      siblingIndex: 1,
      siblingCount: 2,
    });
    const childDestinations = childActions[0]?.subactions ?? [];
    expect(childActions.map((action) => action.id)).toEqual(["project:move", "project:up"]);
    expect(childDestinations.find((action) => action.id === "project:section:x")?.state).toBe("on");
  });
});
