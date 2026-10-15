// signalbox: a new task is filed in its draft's folder before it starts.
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { AppText } from "../../components/AppText";
import { signalboxFolders } from "../../state/signalboxFolders";
import { useAtomCommand } from "../../state/use-atom-command";
import type { NewTaskFolders } from "./draft-folder";
import type { FolderStart } from "./folder-filter";
import { useFolderCommandRunner } from "./use-folder-actions";

/**
 * Files the thread a draft is about to start in the draft's folder. A
 * thread can be filed before it exists, so its first turn already runs on
 * the folder's pool and instructions. Resolves whether to go on sending:
 * false only when filing failed (the user is told why). Offline it can't be
 * filed; `FolderDraftOfflineNotice` says where it starts instead.
 */
export function useFileDraftInFolder(flow: {
  readonly folders: NewTaskFolders;
  readonly setSubmitting: (value: boolean) => void;
}) {
  const moveThread = useAtomCommand(signalboxFolders.moveThread, { reportFailure: false });
  const run = useFolderCommandRunner();
  const target = flow.folders.target;
  const setSubmitting = flow.setSubmitting;
  return async (
    message: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
    context: { readonly editing: boolean; readonly connected: boolean },
  ): Promise<boolean> => {
    if (target === null || !target.file || context.editing || !context.connected) return true;
    setSubmitting(true);
    try {
      return await run(
        `Couldn’t start it in ${target.name}`,
        moveThread({
          environmentId: message.environmentId,
          input: { threadId: message.threadId, folderId: target.folderId },
        }),
      );
    } finally {
      setSubmitting(false);
    }
  };
}

/** Says where a task starts when it's queued offline and can't be filed in its folder. */
export function FolderDraftOfflineNotice(props: {
  readonly target: FolderStart | null;
  readonly connected: boolean;
}) {
  const { target } = props;
  if (target === null || !target.file || props.connected) return null;
  return (
    <AppText className="px-3 py-2 text-xs text-foreground-muted">
      Offline, so it’ll start in {target.unfiledName} instead of {target.name}. You can move it once
      it’s there.
    </AppText>
  );
}
