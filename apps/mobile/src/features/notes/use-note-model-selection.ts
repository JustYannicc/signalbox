// signalbox: what a task started from a note runs on, picked as a new thread at its level would.
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ModelSelection,
} from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import type { FolderLevel } from "@t3tools/contracts/signalboxFolders";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useMemo } from "react";

import { resolveDefaultableModelSelection } from "../../lib/modelOptions";
import { useEnvironmentServerConfig, useProject } from "../../state/entities";
import { useEnvironmentFolders, useFolderOwners } from "../../state/signalboxFolders";
import { useStickyComposerModelSelection } from "../../state/use-composer-drafts";
import { folderStart } from "../folders/folder-filter";
import { useProjectPoolModelSelection } from "../sections/useProjectPool";

const NO_PROVIDERS: never[] = [];

/**
 * The project default (else the last model used) moved onto the level's pool,
 * like the new-task flow does. Null leaves the choice to the server.
 */
export function useNoteModelSelection(
  environmentId: EnvironmentId,
  level: FolderLevel,
): ModelSelection | null {
  const folders = useEnvironmentFolders(environmentId).data;
  const owners = useFolderOwners(environmentId);
  const folderId = level._tag === "folder" ? level.folderId : null;
  const start = useMemo(() => {
    if (!folders) return null;
    // A note's top level is its author's own: Personal's.
    const ownerId =
      owners?.contexts.find((context) => context.kind === "personal")?.id ?? PERSONAL_CONTEXT_ID;
    return folderStart(
      folders,
      owners,
      environmentId,
      folderId === null ? { _tag: "top", ownerId } : { _tag: "folder", folderId },
    );
  }, [environmentId, folderId, folders, owners]);
  const projectId = start?.projectId ?? null;
  const config = useEnvironmentServerConfig(environmentId);
  const project = useProject(projectId === null ? null : { environmentId, projectId });
  const settings = useMemo(
    () =>
      resolveProjectSettings(config?.settings ?? DEFAULT_SERVER_SETTINGS, projectId, project)
        .settings,
    [config?.settings, project, projectId],
  );
  const sticky = useStickyComposerModelSelection();
  const fallback = settings.defaultModelSelection ?? sticky;
  const onPool = useProjectPoolModelSelection({
    environmentId,
    projectId,
    selection: fallback,
    providerInstances: settings.providerInstances,
    providers: config?.providers ?? NO_PROVIDERS,
    home: { folderId },
  });
  return resolveDefaultableModelSelection(config, onPool ?? fallback, projectId);
}
