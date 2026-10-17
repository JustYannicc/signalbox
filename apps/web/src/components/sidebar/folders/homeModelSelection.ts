/**
 * The model work started in a folder (or at the top level) runs on: what it
 * would start on anyway, moved onto that level's pool. A new thread there and
 * a note turned into a task there agree on it.
 */
import { RegistryContext } from "@effect/atom-react";
import { poolModelSelection } from "@t3tools/client-runtime/state/sections";
import {
  newThreadIn,
  ownerFilesProject,
  poolOfHome,
} from "@t3tools/client-runtime/state/signalboxFolders";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ServerConfig,
} from "@t3tools/contracts";
import type { AccountPoolId } from "@t3tools/contracts/accountHub";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import type { FolderId } from "@t3tools/contracts/signalboxFolders";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useCallback, useContext } from "react";

import { useComposerDraftStore } from "../../../composerDraftStore";
import { readProjects } from "../../../state/entities";
import { draftModelSelection } from "../../../state/projectPool";
import { environmentServerConfigsAtom } from "../../../state/server";
import { environmentContextsAtom } from "../../../state/signalboxContexts";
import { environmentFoldersAtom } from "../../../state/signalboxFolders";

/** The settings a new thread in `projectId` starts under. */
export function projectSettingsIn(
  config: ServerConfig | undefined,
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
) {
  const project = readProjects().find(
    (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
  );
  return resolveProjectSettings(config?.settings ?? DEFAULT_SERVER_SETTINGS, projectId, project)
    .settings;
}

/** `selection` moved onto `poolId`, under `settings`; null when the pool can't run it. */
export function selectionOnPool(input: {
  readonly config: ServerConfig | undefined;
  readonly settings: ReturnType<typeof projectSettingsIn>;
  readonly selection: ModelSelection | null;
  readonly poolId: AccountPoolId;
}): ModelSelection | null {
  return poolModelSelection({
    selection: input.selection,
    pool: { poolId: input.poolId },
    providerInstances: input.settings.providerInstances,
    providers: input.config?.providers ?? [],
  });
}

/**
 * What a fresh thread in `folderId` would run on, read when called: the
 * default model of the project it would work in (the folder's files, else its
 * owner's own; the author's Personal at the top level), else the last one
 * picked, on the level's pool. Null leaves the choice to the server.
 */
export function useHomeModelSelection() {
  const registry = useContext(RegistryContext);
  return useCallback(
    (environmentId: EnvironmentId, folderId: FolderId | null): ModelSelection | null => {
      const config = registry.get(environmentServerConfigsAtom).get(environmentId);
      const snapshot = registry.get(environmentFoldersAtom).get(environmentId)?.snapshot ?? null;
      const contexts = registry.get(environmentContextsAtom).get(environmentId)?.contexts ?? [];
      const ownerId =
        folderId === null
          ? (contexts.find((context) => context.kind === "personal")?.id ?? PERSONAL_CONTEXT_ID)
          : snapshot?.folders.find((folder) => folder.id === folderId)?.ownerId;
      const owner = contexts.find((context) => context.id === ownerId);
      const ownerProjectId = owner === undefined ? null : ownerFilesProject(owner);
      const projectId =
        snapshot === null || ownerProjectId === null
          ? null
          : newThreadIn(snapshot, folderId, ownerProjectId).projectId;
      const settings = projectSettingsIn(config, environmentId, projectId);
      const { stickyActiveProvider, stickyModelSelectionByProvider } =
        useComposerDraftStore.getState();
      const selection =
        settings.defaultModelSelection ??
        draftModelSelection({
          activeProvider: stickyActiveProvider,
          modelSelectionByProvider: stickyModelSelectionByProvider,
        });
      const pool = snapshot && poolOfHome(snapshot, folderId);
      if (!pool) return selection;
      return selectionOnPool({ config, settings, selection, poolId: pool.poolId }) ?? selection;
    },
    [registry],
  );
}
