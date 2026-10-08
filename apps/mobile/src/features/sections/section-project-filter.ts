import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ScopedProjectRef } from "@t3tools/contracts";

import { scopedProjectKey } from "../../lib/scopedEntities";
import { findHomeProjectScope, type HomeProjectScope } from "../home/homeThreadList";

const SECTION_PROJECT_PREFIX = "section-project:";

export function sectionProjectFilterKey(ref: ScopedProjectRef): string {
  return `${SECTION_PROJECT_PREFIX}${scopedProjectKey(ref.environmentId, ref.projectId)}`;
}

function isSectionProjectFilterKey(key: string): boolean {
  return key.startsWith(SECTION_PROJECT_PREFIX);
}

export function resolveSelectedProjectScope(input: {
  readonly selectedProjectKey: string | null;
  readonly projectScopes: ReadonlyArray<HomeProjectScope>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
}): HomeProjectScope | null {
  const { selectedProjectKey, projectScopes, projects } = input;
  if (selectedProjectKey === null) return null;

  const sectionProjectKey = selectedProjectKey.startsWith(SECTION_PROJECT_PREFIX)
    ? selectedProjectKey.slice(SECTION_PROJECT_PREFIX.length)
    : null;
  if (sectionProjectKey !== null) {
    const availableProjectRef = projectScopes
      .flatMap((scope) => scope.projectRefs)
      .find((ref) => scopedProjectKey(ref.environmentId, ref.projectId) === sectionProjectKey);
    if (availableProjectRef === undefined) return null;
    const project = projects.find(
      (candidate) =>
        scopedProjectKey(candidate.environmentId, candidate.id) ===
        scopedProjectKey(availableProjectRef.environmentId, availableProjectRef.projectId),
    );
    if (project === undefined) return null;
    const ref = { environmentId: project.environmentId, projectId: project.id };
    return {
      key: selectedProjectKey,
      title: project.title,
      representative: project,
      projects: [project],
      projectRefs: [ref],
    };
  }

  return findHomeProjectScope(projectScopes, selectedProjectKey);
}

export function projectFilterOptions(input: {
  readonly selectedProjectKey: string | null;
  readonly projectScopes: ReadonlyArray<HomeProjectScope>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
}): ReadonlyArray<{ readonly key: string; readonly label: string }> {
  const options = input.projectScopes.map((scope) => ({ key: scope.key, label: scope.title }));
  const selectedScope = resolveSelectedProjectScope(input);
  if (
    selectedScope !== null &&
    isSectionProjectFilterKey(input.selectedProjectKey ?? "") &&
    !options.some((option) => option.key === selectedScope.key)
  ) {
    options.push({ key: selectedScope.key, label: selectedScope.title });
  }
  return options;
}
