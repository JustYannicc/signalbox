import type { Automation, EnvironmentId, ProjectId, ScopedProjectRef } from "@t3tools/contracts";

/**
 * Where "New automation" starts its draft: the project of the automation that
 * ran most recently, else the first project on an environment that runs
 * automations. The draft screen can still switch projects.
 */
export function newAutomationProject(
  automations: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly automation: Automation;
  }>,
  projects: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly id: ProjectId }>,
  environmentIds: ReadonlySet<EnvironmentId>,
): ScopedProjectRef | null {
  const loaded = (environmentId: EnvironmentId, projectId: ProjectId) =>
    projects.some((project) => project.environmentId === environmentId && project.id === projectId);
  const recent = automations
    .filter((entry) => loaded(entry.environmentId, entry.automation.projectId))
    .sort((left, right) =>
      (right.automation.lastRun?.startedAt ?? right.automation.updatedAt).localeCompare(
        left.automation.lastRun?.startedAt ?? left.automation.updatedAt,
      ),
    )[0];
  if (recent)
    return { environmentId: recent.environmentId, projectId: recent.automation.projectId };
  const first = projects.find((project) => environmentIds.has(project.environmentId));
  return first ? { environmentId: first.environmentId, projectId: first.id } : null;
}
