// signalbox: Thread details says whether the thread is a chat or a task, and flips it in one click (#46).
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { useThreadShell } from "../../state/entities";
import {
  flipThreadKind,
  type ThreadKindShell,
  useThreadKind,
} from "../../state/signalboxThreadKinds";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS } from "../chat/threadDetailsPanelStyles";
import { THREAD_KIND_ICON, useNowMs } from "./ThreadKindIcon";
import { THREAD_KIND_LABEL, threadKindDetail, threadKindFlipLabel } from "./threadKind.logic";

function KindRow(props: { readonly threadRef: ScopedThreadRef; readonly shell: ThreadKindShell }) {
  const kind = useThreadKind(props.threadRef, props.shell);
  const nowMs = useNowMs();
  // Environments that keep no kinds say nothing.
  if (kind === null) return null;
  const detail = threadKindDetail(kind, nowMs);
  const Icon = THREAD_KIND_ICON[kind.kind];
  return (
    <div className={cn(THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS, "flex items-center pe-1")}>
      <Icon className="size-4 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">
        {THREAD_KIND_LABEL[kind.kind]}
        {detail ? <span className="text-muted-foreground"> · {detail}</span> : null}
      </span>
      {kind.canChange ? (
        <ThreadDetailsControl
          part="meta"
          onClick={() => void flipThreadKind(kind.threadRef, kind.kind)}
        >
          {threadKindFlipLabel(kind.kind)}
        </ThreadDetailsControl>
      ) : null}
    </div>
  );
}

export function ThreadKindRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const threadRef = { environmentId: props.environmentId, threadId: props.threadId };
  const shell = useThreadShell(threadRef);
  if (shell === null) return null;
  return <KindRow threadRef={threadRef} shell={shell} />;
}
