import { describe, expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import { SectionId, type Section, type SectionsSnapshot } from "@t3tools/contracts/sections";

import {
  applySectionsSnapshotForSession,
  sectionMoveDestinations,
  sectionTreeFromSnapshot,
  siblingProjectMove,
  siblingSectionMove,
} from "./sections.ts";

const section = (id: string, parentId: string | null, position: number): Section => ({
  id: SectionId.make(id),
  name: id,
  parentId: parentId === null ? null : SectionId.make(parentId),
  position,
});

const projectId = (id: string) => ProjectId.make(id);

const snapshot = (
  revision: number,
  sections: ReadonlyArray<Section> = [],
  projectPlacements: SectionsSnapshot["projectPlacements"] = [],
): SectionsSnapshot => ({ revision, sections, projectPlacements });

describe("section state", () => {
  it("ignores a stale snapshot replayed after reconnect", () => {
    const latest = snapshot(12, [section("current", null, 0)]);
    const replayed = snapshot(10, [section("old", null, 0)]);
    const session = {};
    const reconnect = {};

    const connected = applySectionsSnapshotForSession(
      { session: null, snapshot: null },
      session,
      session,
      latest,
    );
    const afterReconnect = applySectionsSnapshotForSession(connected, session, session, replayed);

    expect(afterReconnect).toBe(connected);
    const reconnected = applySectionsSnapshotForSession(
      afterReconnect,
      reconnect,
      reconnect,
      snapshot(1),
    );
    expect(reconnected).toEqual({ session: reconnect, snapshot: snapshot(1) });
    expect(applySectionsSnapshotForSession(reconnected, reconnect, session, replayed)).toBe(
      reconnected,
    );
    expect(applySectionsSnapshotForSession(reconnected, reconnect, reconnect, snapshot(2))).toEqual(
      { session: reconnect, snapshot: snapshot(2) },
    );
  });

  it("orders nested sections and placements while preserving legacy projects", () => {
    const inNestedSection = { id: projectId("nested-project"), label: "nested" };
    const atRoot = { id: projectId("root-project"), label: "root" };
    const unplaced = { id: projectId("legacy-project"), label: "legacy" };
    const tree = sectionTreeFromSnapshot(
      snapshot(
        3,
        [section("later-root", null, 1), section("child", "root", 0), section("root", null, 0)],
        [
          {
            projectId: inNestedSection.id,
            sectionId: SectionId.make("child"),
            position: 0,
          },
          { projectId: atRoot.id, sectionId: null, position: 0 },
        ],
      ),
      [unplaced, inNestedSection, atRoot],
    );

    expect(tree.roots.map((node) => node.section.id)).toEqual(["root", "later-root"]);
    expect(tree.roots[0]?.childSections[0]?.section.id).toBe("child");
    expect(tree.roots[0]?.childSections[0]?.projects).toEqual([inNestedSection]);
    expect(tree.rootProjects).toEqual([atRoot]);
    expect(tree.unplacedProjects).toEqual([unplaced]);
  });

  it("keeps existing projects visible with no sections or placement rows", () => {
    const projects = [
      { id: projectId("one"), label: "One" },
      { id: projectId("two"), label: "Two" },
    ];

    expect(sectionTreeFromSnapshot(snapshot(0), projects)).toEqual({
      roots: [],
      rootProjects: [],
      unplacedProjects: projects,
    });
    expect(sectionTreeFromSnapshot(null, projects).unplacedProjects).toEqual(projects);
  });

  it("offers only valid section parents and reorders project siblings at root", () => {
    const sections = [
      section("a", null, 0),
      section("b", "a", 0),
      section("c", "b", 0),
      section("d", null, 1),
    ];
    const rootOne = projectId("root-one");
    const rootTwo = projectId("root-two");
    const implicitRoot = projectId("implicit-root");
    const tree = snapshot(4, sections, [
      { projectId: rootOne, sectionId: null, position: 0 },
      { projectId: rootTwo, sectionId: null, position: 1 },
    ]);

    expect(
      sectionMoveDestinations(tree, SectionId.make("a")).map(({ section }) => section.id),
    ).toEqual(["d"]);
    expect(
      siblingSectionMove({
        sectionId: SectionId.make("d"),
        parentId: null,
        direction: "up",
        sections,
      }),
    ).toEqual({ parentId: null, beforeId: SectionId.make("a") });
    expect(
      siblingProjectMove({
        projectId: rootTwo,
        sectionId: null,
        direction: "up",
        snapshot: tree,
        projects: [{ id: implicitRoot }, { id: rootOne }, { id: rootTwo }],
      }),
    ).toEqual({ sectionId: null, beforeProjectId: rootOne });
    expect(
      siblingProjectMove({
        projectId: implicitRoot,
        sectionId: null,
        direction: "up",
        snapshot: tree,
        projects: [{ id: implicitRoot }, { id: rootOne }, { id: rootTwo }],
      }),
    ).toEqual({ sectionId: null, beforeProjectId: rootTwo });
  });
});
