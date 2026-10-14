/** Signalbox Cloud folders, per cloud environment (see `signalboxContexts.ts`). */
import { createSignalboxFoldersAtoms } from "@t3tools/client-runtime/state/signalboxFolders";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentServerConfig } from "./entities";
import { useEnvironmentQuery } from "./query";
import { signalboxContexts } from "./signalboxContexts";
import { environmentThreadShells } from "./threads";

export const signalboxFolders = createSignalboxFoldersAtoms(connectionAtomRuntime);

/** Whether the environment keeps folders. Self-hosted servers keep sections instead. */
export function useEnvironmentHasFolders(environmentId: EnvironmentId | null): boolean {
  return useEnvironmentServerConfig(environmentId)?.environment.capabilities.folders === true;
}

/** The environment's folders; data is null where it has none or hasn't sent them yet. */
export function useEnvironmentFolders(environmentId: EnvironmentId | null) {
  const supported = useEnvironmentHasFolders(environmentId);
  const query = useEnvironmentQuery(
    supported && environmentId !== null
      ? signalboxFolders.snapshot({ environmentId, input: {} })
      : null,
  );
  return { supported, ...query };
}

/** Whose folders are whose: the owners' names and their projects, where folders exist. */
export function useFolderOwners(environmentId: EnvironmentId | null) {
  const supported = useEnvironmentHasFolders(environmentId);
  return useEnvironmentQuery(
    supported && environmentId !== null
      ? signalboxContexts.snapshot({ environmentId, input: {} })
      : null,
  ).data;
}

export interface FolderThreadResident {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly projectId: ProjectId;
}

let previousResidents: ReadonlyArray<FolderThreadResident> = [];
/**
 * The threads folders count: what the thread list shows. Streaming turns
 * rewrite thread shells many times a second; this only changes when a thread
 * comes, goes, or changes project.
 */
export const folderThreadResidentsAtom = Atom.make((get) => {
  const next = get(environmentThreadShells.navigationThreadShellsAtom).map((thread) => ({
    environmentId: thread.environmentId,
    id: thread.id,
    projectId: thread.projectId,
  }));
  const same =
    next.length === previousResidents.length &&
    next.every((resident, index) => {
      const previous = previousResidents[index]!;
      return (
        previous.environmentId === resident.environmentId &&
        previous.id === resident.id &&
        previous.projectId === resident.projectId
      );
    });
  if (!same) previousResidents = next;
  return previousResidents;
}).pipe(Atom.withLabel("signalbox-folder-thread-residents"));
