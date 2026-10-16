// signalbox: a thread's Home row under a folder says what happens next (#670), under its title.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadStatusOf } from "@t3tools/client-runtime/state/threadStatusLine";
import type { ReactNode } from "react";

import { useThreadStatusNote } from "../../state/signalboxThreadStatus";
import type { SidebarThreadSummary } from "../../types";
import { useSidebarThreadScope } from "../sidebar/folders/threadScope";

/**
 * Wraps a sidebar thread row's title. Inside a folder home, a thread with a
 * note gets its next step as one muted line below; every other row renders
 * its title untouched.
 */
export function ThreadRowTitle(props: {
  readonly thread: SidebarThreadSummary;
  readonly children: ReactNode;
}) {
  return useSidebarThreadScope() === null ? (
    props.children
  ) : (
    <FolderThreadRowTitle thread={props.thread}>{props.children}</FolderThreadRowTitle>
  );
}

function FolderThreadRowTitle(props: {
  readonly thread: SidebarThreadSummary;
  readonly children: ReactNode;
}) {
  const { thread } = props;
  const note = useThreadStatusNote(scopeThreadRef(thread.environmentId, thread.id));
  // Archived and settled threads are done; their next step no longer applies.
  if (note === null || threadStatusOf(thread.source).state === "archived") return props.children;
  return (
    <span className="flex min-w-0 flex-1 flex-col py-0.5">
      {props.children}
      <span className="truncate text-2xs leading-4 text-sidebar-muted-foreground/70">
        <span className="text-sidebar-muted-foreground/50">Next: </span>
        {note.nextStep}
      </span>
    </span>
  );
}
