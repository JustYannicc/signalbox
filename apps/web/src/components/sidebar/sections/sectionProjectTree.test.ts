import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import type { OrchestrationProjectShell } from "@t3tools/contracts";
import { SectionId } from "@t3tools/contracts/sections";
import { describe, expect, it } from "vite-plus/test";

import { buildSidebarProjectSnapshots } from "../../../sidebarProjectGrouping";
import type { Project } from "../../../types";
import { sectionTreeFromSnapshot } from "@t3tools/client-runtime/state/sections";
import type { SectionsSnapshot } from "@t3tools/contracts/sections";
import {
  buildSectionSidebarEnvironment,
  hasAnySavedSectionSidebarState,
  sectionSidebarSectionKey,
  visibleSectionProjectRows,
} from "./sectionProjectTree";

const environmentA = EnvironmentId.make("section-env-a");
const environmentB = EnvironmentId.make("section-env-b");
const repositoryIdentity = {
  canonicalKey: "github.com/example/section-project",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/example/section-project.git",
  },
};

function project(environmentId: EnvironmentId, id: string, workspaceRoot: string): Project {
  return {
    id: ProjectId.make(id),
    environmentId,
    title: "section-project",
    workspaceRoot,
    repositoryIdentity,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  };
}

function projectShell(id: string, workspaceRoot: string): OrchestrationProjectShell {
  return {
    id: ProjectId.make(id),
    title: "section-project",
    workspaceRoot,
    repositoryIdentity,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const groupingSettings = {
  sidebarProjectGroupingMode: "repository" as const,
  sidebarProjectGroupingOverrides: {},
};

function groups(projects: ReadonlyArray<Project>) {
  return buildSidebarProjectSnapshots({
    projects,
    settings: groupingSettings,
    primaryEnvironmentId: environmentA,
    resolveEnvironmentLabel: (environmentId) =>
      environmentId === environmentB ? "Environment B" : "Environment A",
  });
}

function buildEnvironment(input: {
  environmentId: EnvironmentId;
  projects: ReadonlyArray<OrchestrationProjectShell>;
  projectGroups: ReturnType<typeof groups>;
  snapshot?: SectionsSnapshot;
}) {
  return buildSectionSidebarEnvironment({
    environmentId: input.environmentId,
    label: input.environmentId === environmentB ? "Environment B" : "Environment A",
    primaryEnvironmentId: environmentA,
    isDesktopLocalEnvironment: false,
    isWslEnvironment: false,
    projects: input.projects,
    projectGroups: input.projectGroups,
    serverView: input.snapshot
      ? {
          status: { _tag: "Ready" },
          snapshot: input.snapshot,
          tree: sectionTreeFromSnapshot(input.snapshot, input.projects),
        }
      : undefined,
  });
}

describe("section sidebar project adapter", () => {
  it("keeps same-ID projects scoped to their environment and as physical rows", () => {
    const environmentBProject = project(environmentB, "shared-project", "/work/environment-b");
    const environmentAProject = project(environmentA, "shared-project", "/work/environment-a");
    const sourceGroup = groups([environmentBProject, environmentAProject])[0]!;
    const groupWithEnvironmentBFirst = {
      ...sourceGroup,
      memberProjects: [
        sourceGroup.memberProjects.find((member) => member.environmentId === environmentB)!,
        sourceGroup.memberProjects.find((member) => member.environmentId === environmentA)!,
      ],
    };
    const row = buildEnvironment({
      environmentId: environmentA,
      projects: [projectShell("shared-project", "/work/environment-a")],
      projectGroups: [groupWithEnvironmentBFirst],
    }).tree.unplacedProjects[0]!;

    expect(row.id).toBe(ProjectId.make("shared-project"));
    expect(row.project.workspaceRoot).toBe("/work/environment-a");
    expect(row.project.memberProjects.map((member) => member.environmentId)).toEqual([
      environmentA,
    ]);
  });

  it("keeps persisted root order after the last section is deleted", () => {
    const first = project(environmentA, "first-project", "/work/first");
    const second = project(environmentA, "second-project", "/work/second");
    const snapshot: SectionsSnapshot = {
      revision: 4,
      sections: [],
      projectPlacements: [
        { projectId: second.id, sectionId: null, position: 0 },
        { projectId: first.id, sectionId: null, position: 1 },
      ],
    };
    const view = buildEnvironment({
      environmentId: environmentA,
      projects: [
        projectShell(first.id, first.workspaceRoot),
        projectShell(second.id, second.workspaceRoot),
      ],
      projectGroups: groups([first, second]),
      snapshot,
    });

    expect(hasAnySavedSectionSidebarState([view])).toBe(true);
    expect(view.snapshot?.sections).toEqual([]);
    expect(view.tree.rootProjects.map((row) => row.id)).toEqual([second.id, first.id]);
  });

  it("derives shortcut rows in rendered order and skips collapsed sections", () => {
    const first = project(environmentA, "first-project", "/work/first");
    const second = project(environmentA, "second-project", "/work/second");
    const sectionId = SectionId.make("planning");
    const snapshot: SectionsSnapshot = {
      revision: 1,
      sections: [{ id: sectionId, name: "Planning", parentId: null, position: 0 }],
      projectPlacements: [
        { projectId: first.id, sectionId, position: 0 },
        { projectId: second.id, sectionId: null, position: 0 },
      ],
    };
    const view = buildEnvironment({
      environmentId: environmentA,
      projects: [
        projectShell(first.id, first.workspaceRoot),
        projectShell(second.id, second.workspaceRoot),
      ],
      projectGroups: groups([first, second]),
      snapshot,
    });

    expect(visibleSectionProjectRows([view], new Set()).map((row) => row.project.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(
      visibleSectionProjectRows(
        [view],
        new Set([sectionSidebarSectionKey(environmentA, sectionId)]),
      ).map((row) => row.project.id),
    ).toEqual([second.id]);
  });
});
