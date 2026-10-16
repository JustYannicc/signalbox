// signalbox: Thread details leads with the thread's status line (#670): what's going on,
// what happens next, and where it got to, the same line for everyone with access.
import {
  threadStatusHeadline,
  threadStatusLine,
  type ThreadStatusState,
} from "@t3tools/client-runtime/state/threadStatusLine";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ThreadStatusNote } from "@t3tools/contracts/signalboxStatusLine";
import * as DateTime from "effect/DateTime";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { useThreadShell } from "../../state/entities";
import { useThreadStatusNote } from "../../state/signalboxThreadStatus";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ThreadDetailsSection } from "../chat/ThreadDetailsSection";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Same hues as the sidebar's status dots; static, never pulsing. */
const STATE_DOT_CLASS: Record<ThreadStatusState, string> = {
  working: "bg-sky-500 dark:bg-sky-300/80",
  waiting_on_person: "bg-amber-500 dark:bg-amber-300/90",
  waiting_on_other: "bg-muted-foreground/60",
  idle: "bg-muted-foreground/40",
  archived: "bg-muted-foreground/40",
};

export function ThreadStatusLineSection(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const threadRef = { environmentId: props.environmentId, threadId: props.threadId };
  const shell = useThreadShell(threadRef);
  const note = useThreadStatusNote(threadRef);
  if (shell === null) return null;
  const line = threadStatusLine(shell.source, note);

  return (
    // The first section: its own rule below, since Workspace starts unseparated.
    <div className="border-b border-border/65">
      <ThreadDetailsSection
        headingId="thread-details-status-heading"
        title="Status"
        separated={false}
        showHeading={false}
      >
        <div className="flex flex-col gap-1.5 px-2.5 pt-1.5 text-[13px]">
          <p className="m-0 flex min-w-0 items-center gap-2 font-medium text-foreground/80">
            <span
              aria-hidden
              className={cn("size-2 shrink-0 rounded-full", STATE_DOT_CLASS[line.state])}
            />
            <span className="min-w-0">{threadStatusHeadline(line)}</span>
          </p>
          {line.note ? <StatusNote note={line.note} /> : null}
        </div>
      </ThreadDetailsSection>
    </div>
  );
}

function StatusNote(props: { readonly note: ThreadStatusNote }) {
  const { note } = props;
  const writtenAt = DateTime.formatIso(note.writtenAt);
  return (
    <>
      <p className="m-0 text-foreground/80">
        <span className="text-muted-foreground">Next: </span>
        {note.nextStep}
      </p>
      <p className="m-0 text-xs leading-relaxed text-muted-foreground">{note.whereItGotTo}</p>
      <NoteUpdated writtenAt={writtenAt} writtenBy={note.writtenBy} />
    </>
  );
}

/** Ticks with the shared minute clock, so "5m ago" stays true while the card is open. */
function NoteUpdated(props: {
  readonly writtenAt: string;
  readonly writtenBy: ThreadStatusNote["writtenBy"];
}) {
  useNowMinute();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <time dateTime={props.writtenAt} className="w-fit text-2xs text-muted-foreground/70" />
        }
      >
        Updated {formatRelativeTimeLabel(props.writtenAt)}
      </TooltipTrigger>
      <TooltipPopup side="left">
        {props.writtenBy === "agent"
          ? "Written by the agent"
          : "Written from the last turn, since the agent didn't write one"}
      </TooltipPopup>
    </Tooltip>
  );
}
