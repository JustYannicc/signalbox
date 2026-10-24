/** Signalbox Cloud folders, per cloud environment (see `signalboxContexts.ts`). */
import { createSignalboxFoldersAtoms } from "@t3tools/client-runtime/state/signalboxFolders";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { SignalboxContextsSnapshot } from "@t3tools/contracts/signalboxContexts";
import type { SignalboxFoldersSnapshot } from "@t3tools/contracts/signalboxFolders";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentServerConfig } from "./entities";
import { useEnvironments } from "./environments";
import { useEnvironmentQuery } from "./query";
import { environmentServerConfigsAtom } from "./server";
import { signalboxContexts } from "./signalboxContexts";
import { environmentThreadShells } from "./threads";

export const signalboxFolders = createSignalboxFoldersAtoms(connectionAtomRuntime);

/** The connected environments that keep folders. */
export function useFolderEnvironments() {
  return useEnvironments().environments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.folders === true,
  );
}

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

export interface FolderEnvironment {
  readonly snapshot: SignalboxFoldersSnapshot;
  readonly owners: SignalboxContextsSnapshot;
}

/**
 * Every environment whose folders and owners have both arrived. An
 * environment whose snapshots didn't change keeps its entry.
 */
export const folderEnvironmentsAtom = Atom.make((get) => {
  const previous = Option.getOrUndefined(get.self<ReadonlyMap<EnvironmentId, FolderEnvironment>>());
  const environments = new Map<EnvironmentId, FolderEnvironment>();
  for (const [environmentId, config] of get(environmentServerConfigsAtom)) {
    if (config.environment.capabilities.folders !== true) continue;
    const input = { environmentId, input: {} };
    const snapshot = Option.getOrNull(AsyncResult.value(get(signalboxFolders.snapshot(input))));
    const owners = Option.getOrNull(AsyncResult.value(get(signalboxContexts.snapshot(input))));
    if (snapshot === null || owners === null) continue;
    const kept = previous?.get(environmentId);
    environments.set(
      environmentId,
      kept?.snapshot === snapshot && kept.owners === owners ? kept : { snapshot, owners },
    );
  }
  const unchanged =
    previous !== undefined &&
    previous.size === environments.size &&
    [...environments].every(([id, entry]) => previous.get(id) === entry);
  return unchanged ? previous : environments;
}).pipe(Atom.withLabel("signalbox-folder-environments"));

export interface FolderThreadResident {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly projectId: ProjectId;
}

const sameResidents = (
  left: ReadonlyArray<FolderThreadResident>,
  right: ReadonlyArray<FolderThreadResident>,
) =>
  left.length === right.length &&
  left.every(
    (resident, index) =>
      resident.environmentId === right[index]!.environmentId &&
      resident.id === right[index]!.id &&
      resident.projectId === right[index]!.projectId,
  );

/**
 * The threads folders count: what the thread list shows. Streaming turns
 * rewrite thread shells many times a second; this keeps its array until a
 * thread comes, goes, or changes project.
 */
export const folderThreadResidentsAtom = Atom.make((get) => {
  const residents = get(environmentThreadShells.navigationThreadShellsAtom).map((thread) => ({
    environmentId: thread.environmentId,
    id: thread.id,
    projectId: thread.projectId,
  }));
  const previous = Option.getOrUndefined(get.self<ReadonlyArray<FolderThreadResident>>());
  return previous !== undefined && sameResidents(previous, residents) ? previous : residents;
}).pipe(Atom.withLabel("signalbox-folder-thread-residents"));
