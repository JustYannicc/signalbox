/**
 * Whether a draft was filed in a folder away from where its project's threads
 * live, read when a new thread is asked for. Plain New never reuses one: a
 * draft keeps its folder only when it was started from that folder
 * (`useStartInFolder`), so "/" and New can't land somewhere nobody picked.
 */
import { RegistryContext } from "@effect/atom-react";
import { isFiledAway } from "@t3tools/client-runtime/state/signalboxFolders";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useCallback, useContext } from "react";

import { environmentFoldersAtom } from "../../../state/signalboxFolders";

export function useDraftFiledAway() {
  const registry = useContext(RegistryContext);
  return useCallback(
    (draft: {
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
    }) => {
      const snapshot = registry.get(environmentFoldersAtom).get(draft.environmentId)?.snapshot;
      return (
        snapshot != null &&
        isFiledAway(snapshot, { id: draft.threadId, projectId: draft.projectId })
      );
    },
    [registry],
  );
}
