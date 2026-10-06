import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  projectFilterOptions,
  resolveSelectedProjectScope,
  sectionProjectFilterKey,
} from "./section-project-filter";

const environmentId = EnvironmentId.make("environment-a");

function project(
  id: string,
  title: string,
  targetEnvironmentId = environmentId,
): EnvironmentProject {
  return {
    id: ProjectId.make(id),
    environmentId: targetEnvironmentId,
    title,
    workspaceRoot: `/workspaces/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

describe("mobile section project filters", () => {
  it("keeps a physical project selected inside a grouped repository scope", () => {
    const first = project("first", "First project");
    const second = project("second", "Second project");
    const selectedProjectKey = sectionProjectFilterKey({ environmentId, projectId: second.id });
    const projectScopes = [
      {
        key: "repository:mono",
        title: "mono",
        representative: first,
        projects: [first, second],
        projectRefs: [
          { environmentId, projectId: first.id },
          { environmentId, projectId: second.id },
        ],
      },
    ];
    const input = { selectedProjectKey, projectScopes, projects: [first, second] };

    expect(resolveSelectedProjectScope(input)?.projectRefs).toEqual([
      { environmentId, projectId: second.id },
    ]);
    expect(projectFilterOptions(input)).toEqual([
      { key: "repository:mono", label: "mono" },
      { key: selectedProjectKey, label: "Second project" },
    ]);
  });

  it("drops the physical selection when switching to another environment", () => {
    const environmentB = EnvironmentId.make("environment-b");
    const projectA = project("project-a", "Project A");
    const projectB = project("project-b", "Project B", environmentB);
    const selectedProjectKey = sectionProjectFilterKey({
      environmentId,
      projectId: projectA.id,
    });
    const projectScopes = [
      {
        key: "project-b",
        title: "Project B",
        representative: projectB,
        projects: [projectB],
        projectRefs: [{ environmentId: environmentB, projectId: projectB.id }],
      },
    ];
    const input = { selectedProjectKey, projectScopes, projects: [projectA, projectB] };

    expect(resolveSelectedProjectScope(input)).toBeNull();
    expect(projectFilterOptions(input)).toEqual([{ key: "project-b", label: "Project B" }]);
  });
});
