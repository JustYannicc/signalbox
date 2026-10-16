// signalbox: Thread details list the folders a cloud thread's saved machine leaves out, and how each comes back (#490).
import { useAtomValue } from "@effect/atom-react";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { ChevronDownIcon, FolderSyncIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { environmentThreadDetails } from "../../state/threads";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "../chat/threadDetailsPanelStyles";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { latestSkippedFolders } from "./skippedFolders.logic";

// Narrowed to the skipped list so streaming turns don't re-render the details panel.
const skippedFoldersAtom = Atom.family((key: string) => {
  const ref = parseThreadKey(key);
  return Atom.make((get) => {
    const thread = get(environmentThreadDetails.threadAtom(ref));
    return thread === null ? null : latestSkippedFolders(thread.projection.checkpoints);
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`web-thread-skipped-folders:${key}`));
});

export function ThreadSkippedFoldersRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const skipped = useAtomValue(
    skippedFoldersAtom(threadKey({ environmentId: props.environmentId, threadId: props.threadId })),
  );
  const [open, setOpen] = useState(false);
  // Threads without a saved machine, or whose machine left nothing out, say nothing.
  if (skipped === null) return null;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger render={<ThreadDetailsControl part="row" />}>
        <FolderSyncIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
        <span className={cn("min-w-0 flex-1 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
          Not kept
          <span className="text-muted-foreground">
            {" · "}
            {skipped.map((folder) => folder.path).join(", ")}
          </span>
        </span>
        <ChevronDownIcon
          className={cn(
            THREAD_DETAILS_PANEL_CHEVRON_CLASS,
            "transition-transform duration-150 motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        {/* Indented to the row's label, past its icon. */}
        <ul className="m-0 flex list-none flex-col gap-2 pb-2 ps-9 pe-2.5 pt-1">
          {skipped.map((folder) => (
            <li key={folder.path} className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-xs font-medium text-foreground/80">{folder.path}</span>
              <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {folder.recipe}
              </span>
            </li>
          ))}
        </ul>
      </CollapsiblePanel>
    </Collapsible>
  );
}
