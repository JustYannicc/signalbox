/**
 * Whether a draft was filed in a folder away from where its project's threads
 * live, read when a new thread is asked for. Plain New never reuses one: a
 * draft keeps its folder only when it was started from that folder
 * (`useStartInFolder`), so "/" and New can't land somewhere nobody picked.
 */
import { RegistryContext } from "@effect/atom-react";
import { isFiledAway } from "@t3tools/client-runtime/state/signalboxFolders";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useContext } from "react";

import { type EnvironmentFolders, environmentFoldersAtom } from "../../../state/signalboxFolders";

interface DraftPlace {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
}

/**
 * `folders`: the draft's environment's, undefined where it keeps none. Until
 * they arrive (opening the app runs "/" first) the draft may be filed, so it
 * counts as filed and New starts a fresh one.
 */
export function draftFiledAway(folders: EnvironmentFolders | undefined, draft: DraftPlace) {
  if (folders === undefined) return false;
  if (folders.snapshot === null) return true;
  return isFiledAway(folders.snapshot, { id: draft.threadId, projectId: draft.projectId });
}

export function useDraftFiledAway() {
  const registry = useContext(RegistryContext);
  return (draft: DraftPlace) =>
    draftFiledAway(registry.get(environmentFoldersAtom).get(draft.environmentId), draft);
}
