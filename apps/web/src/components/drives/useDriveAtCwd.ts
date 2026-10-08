import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { environmentProjects } from "../../state/projects";
import { environmentDrivesAtom } from "../../state/signalboxDrives";

/** The drive whose project is rooted at `cwd`, when the environment has drives. */
export function useDriveAtCwd(environmentId: EnvironmentId, cwd: string) {
  const drives = useAtomValue(environmentDrivesAtom).get(environmentId);
  const projects = useAtomValue(environmentProjects.environmentProjectsAtom(environmentId));
  return drives?.drives.find(
    (drive) => projects.find((project) => project.id === drive.projectId)?.workspaceRoot === cwd,
  );
}
