/**
 * Where the bare "/" starts its draft when an environment keeps folders:
 * Personal's top level, whose files are the environment's scratch project.
 * Never the project of whatever ran last, which may be a repository folder
 * nobody picked. Null where no environment keeps folders (or its scratch
 * project hasn't arrived), so the landing keeps upstream's pick.
 */
import { useAtomValue } from "@effect/atom-react";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useMemo } from "react";

import { useProjects } from "../../../state/entities";
import { environmentServerConfigsAtom } from "../../../state/server";
import { environmentFoldersAtom } from "../../../state/signalboxFolders";

export function useTopLevelLanding(): EnvironmentProject | null {
  const folders = useAtomValue(environmentFoldersAtom);
  const configs = useAtomValue(environmentServerConfigsAtom);
  const projects = useProjects();
  return useMemo(() => {
    for (const environmentId of folders.keys()) {
      const scratchRoot = configs.get(environmentId)?.scratchWorkspaceRoot;
      const scratch = projects.find(
        (project) =>
          project.environmentId === environmentId && isScratchProject(project, scratchRoot),
      );
      if (scratch !== undefined) return scratch;
    }
    return null;
  }, [configs, folders, projects]);
}
