// signalbox: what upstream's project copy says where environments keep folders.
import type { EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useMemo } from "react";

import { useProjects, useServerConfigs } from "../../state/entities";
import { folderEnvironmentsAtom, useFolderOwners } from "../../state/signalboxFolders";
import {
  folderCopy,
  folderWording,
  scratchCopy,
  scratchLevelName,
  withScratchScopeTitles,
} from "./folder-copy";

/**
 * Rewords upstream's project copy by the known environments: unchanged where none keeps
 * folders, so self-hosted servers read exactly as upstream.
 */
export function useFolderCopy(): (text: string) => string {
  const configs = useServerConfigs();
  const wording = useMemo(() => {
    let withFolders = 0;
    for (const config of configs.values()) {
      if (config.environment.capabilities.folders === true) withFolders += 1;
    }
    return folderWording({ withFolders, total: configs.size });
  }, [configs]);
  return useCallback((text: string) => folderCopy(text, wording), [wording]);
}

/** The new-task picker's "No project" entry, named after its owner's top level where folders exist. */
export function useScratchCopy(environmentId: EnvironmentId | null) {
  const owners = useFolderOwners(environmentId);
  const projects = useProjects();
  const scratchProjectId =
    projects.find((project) => project.environmentId === environmentId && project.isScratch)?.id ??
    null;
  const levelName = scratchLevelName(owners, scratchProjectId);
  return useMemo(() => scratchCopy(levelName), [levelName]);
}

/** Thread-list scopes with the "No project" group named after its owner where folders exist. */
export function useScratchScopeTitles<
  Scope extends Parameters<typeof withScratchScopeTitles>[0][number],
>(scopes: ReadonlyArray<Scope>): ReadonlyArray<Scope> {
  const environments = useAtomValue(folderEnvironmentsAtom);
  return useMemo(
    () =>
      withScratchScopeTitles(scopes, (environmentId) => environments.get(environmentId)?.owners),
    [environments, scopes],
  );
}
