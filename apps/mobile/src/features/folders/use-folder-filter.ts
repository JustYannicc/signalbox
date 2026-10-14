// signalbox: the thread list's folder filter, and where a new task shown in it starts.
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useEnvironmentFolders, useFolderOwners } from "../../state/signalboxFolders";
import { useHomeListOptions } from "../home/home-list-options";
import {
  type FolderResident,
  type FolderStart,
  folderLevelName,
  folderResidency,
  folderStart,
  parseFolderFilterKey,
} from "./folder-filter";

export interface FolderFilter {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Whether a thread (or a task that isn't one yet) lives right in the folder. */
  readonly includes: (
    resident: FolderResident & { readonly environmentId: EnvironmentId },
  ) => boolean;
}

/** The folders and owners of the environment a filter key names. */
function useFolderKeyData(selectedKey: string | null) {
  const environmentId = parseFolderFilterKey(selectedKey)?.environmentId ?? null;
  return {
    snapshot: useEnvironmentFolders(environmentId).data,
    owners: useFolderOwners(environmentId),
  };
}

/** The folder `selectedKey` names, once its environment has sent its folders; else null. */
export function useFolderFilter(selectedKey: string | null): FolderFilter | null {
  const { snapshot, owners } = useFolderKeyData(selectedKey);
  return useMemo(() => {
    const parsed = parseFolderFilterKey(selectedKey);
    if (!snapshot || !parsed || selectedKey === null) return null;
    const label = folderLevelName(snapshot, owners, parsed.level);
    if (label === null) return null;
    const residency = folderResidency(snapshot, owners);
    return {
      key: selectedKey,
      environmentId: parsed.environmentId,
      label,
      includes: (resident) =>
        resident.environmentId === parsed.environmentId && residency.isAt(parsed.level, resident),
    };
  }, [owners, selectedKey, snapshot]);
}

const NO_ENVIRONMENTS: ReadonlySet<EnvironmentId> = new Set();

/** Where a new task starts while the thread list shows a folder; null otherwise. */
export function useNewTaskFolderStart(): FolderStart | null {
  const selectedKey = useHomeListOptions(NO_ENVIRONMENTS).options.selectedProjectKey;
  const { snapshot, owners } = useFolderKeyData(selectedKey);
  return useMemo(() => {
    const parsed = parseFolderFilterKey(selectedKey);
    return snapshot && parsed
      ? folderStart(snapshot, owners, parsed.environmentId, parsed.level)
      : null;
  }, [owners, selectedKey, snapshot]);
}
