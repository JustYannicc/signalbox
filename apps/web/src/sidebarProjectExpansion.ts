import { legacyProjectCwdPreferenceKey } from "./uiStateStore";

interface ProjectExpansionPreferenceSource {
  readonly projectKey: string;
  readonly memberProjects: ReadonlyArray<{
    readonly physicalProjectKey: string;
    readonly workspaceRoot: string;
  }>;
}

export function projectExpansionPreferenceKeys(
  project: ProjectExpansionPreferenceSource,
  rowKey: string = project.projectKey,
): string[] {
  return [
    rowKey,
    ...project.memberProjects.map((member) => member.physicalProjectKey),
    ...project.memberProjects.map((member) => legacyProjectCwdPreferenceKey(member.workspaceRoot)),
  ];
}
