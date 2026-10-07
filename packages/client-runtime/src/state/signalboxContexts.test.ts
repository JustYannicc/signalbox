import { ProjectId } from "@t3tools/contracts";
import {
  PERSONAL_CONTEXT_ID,
  SignalboxContextId,
  type SignalboxContextsSnapshot,
} from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "vite-plus/test";

import { contextIdOfProject, groupSectionTreeByContext } from "./signalboxContexts.ts";
import { sectionTreeFromSnapshot } from "./sectionsModel.ts";

const scratch = { id: ProjectId.make("scratch") };
const acme = { id: ProjectId.make("context:org_acme") };

const contexts: SignalboxContextsSnapshot = {
  contexts: [
    { id: PERSONAL_CONTEXT_ID, kind: "personal", name: "Personal", projectIds: [scratch.id] },
    {
      id: SignalboxContextId.make("org_acme"),
      kind: "organization",
      name: "Acme",
      projectIds: [acme.id],
    },
  ],
};

describe("groupSectionTreeByContext", () => {
  it("puts each top-level section and project under its own context", () => {
    const tree = sectionTreeFromSnapshot(
      {
        revision: 3,
        sections: [
          { id: "work", name: "Work", parentId: null, position: 0, contextId: "org_acme" },
          { id: "nw", name: "Northwind", parentId: "work", position: 0, contextId: "org_acme" },
          { id: "home", name: "Home", parentId: null, position: 1, contextId: "personal" },
        ],
        projectPlacements: [{ projectId: acme.id, sectionId: "work", position: 0 }],
      },
      [scratch, acme],
    );
    const groups = groupSectionTreeByContext(tree, contexts);
    expect(
      groups.map((group) => ({
        context: group.context.name,
        roots: group.roots.map((node) => [
          node.section.name,
          node.childSections.map((child) => child.section.name),
          node.projects.map((project) => project.id),
        ]),
        projects: group.projects.map((project) => project.id),
      })),
    ).toEqual([
      { context: "Personal", roots: [["Home", [], []]], projects: ["scratch"] },
      {
        context: "Acme",
        roots: [["Work", ["Northwind"], ["context:org_acme"]]],
        projects: [],
      },
    ]);
  });

  it("finds a project's context", () => {
    expect(contextIdOfProject(contexts, acme.id)).toBe("org_acme");
    expect(contextIdOfProject(contexts, ProjectId.make("elsewhere"))).toBeUndefined();
    expect(contextIdOfProject(null, scratch.id)).toBeUndefined();
  });
});
