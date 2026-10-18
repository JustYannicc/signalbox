// signalbox: a cloud folder with files and no remote can be published to GitHub (#810).
import { AuthSourceControlWriteScope, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { CloudUploadIcon } from "lucide-react";
import { useState } from "react";

import type { DraftId } from "../../composerDraftStore";
import { useSourceControlActionRunning } from "../../lib/sourceControlActions";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useResubscribeEnvironmentThread } from "../../state/threads";
import { vcsEnvironment } from "../../state/vcs";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { ThreadDetailsSection } from "../chat/ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "../chat/threadDetailsPanelStyles";
import { Spinner } from "../ui/spinner";
import { PublishFolderDialog } from "./PublishFolderDialog";
import { usePublishableFolder } from "./usePublishableFolder";

/**
 * Thread details' version control for a cloud folder that isn't a repository yet. Renders
 * nothing unless the user can publish it; once published, the folder reports a repository and
 * the usual git controls take this place.
 */
export function PublishFolderSection(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly draftId?: DraftId | undefined;
  /** The tree the thread's git status comes from, refreshed once the folder has a remote. */
  readonly gitCwd: string;
  readonly separated: boolean;
}) {
  const { environmentId, gitCwd } = props;
  const folder = usePublishableFolder(props);
  const canWrite = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const [open, setOpen] = useState(false);
  const scope = { environmentId, cwd: folder?.workspaceRoot ?? null };
  const publishing = useSourceControlActionRunning(scope, ["publishRepository"]);
  const threadStatus = useEnvironmentQuery(
    vcsEnvironment.status({ environmentId, input: { cwd: gitCwd } }),
  );
  const resubscribeThread = useResubscribeEnvironmentThread(
    environmentId,
    props.draftId ? null : props.threadId,
  );
  // The folder root refreshes with the action. The thread moves onto its own branch of the new
  // repository when the server next reads it, so read it now rather than at its next turn.
  const onPublished = () => {
    resubscribeThread();
    threadStatus.refresh();
  };

  if (folder === null || !canWrite) return null;

  return (
    <ThreadDetailsSection
      headingId="thread-details-publish-folder-heading"
      title="Version Control"
      showHeading={false}
      separated={props.separated}
    >
      <ThreadDetailsControl
        type="button"
        variant="ghost"
        size="sm"
        part="row"
        onClick={() => setOpen(true)}
      >
        {publishing ? (
          <Spinner size="sm" aria-hidden className="shrink-0" />
        ) : (
          <CloudUploadIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
        )}
        <span className={cn("flex-1 text-left", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
          {publishing ? "Publishing to GitHub…" : "Publish to GitHub"}
        </span>
      </ThreadDetailsControl>
      <PublishFolderDialog
        environmentId={environmentId}
        threadRef={{ environmentId, threadId: props.threadId }}
        folder={folder}
        open={open}
        onOpenChange={setOpen}
        onPublished={onPublished}
      />
    </ThreadDetailsSection>
  );
}
