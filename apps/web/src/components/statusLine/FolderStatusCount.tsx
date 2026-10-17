// signalbox: a folder row's thread count becomes its status roll-up while anything moves (#670).
import { useAtomValue } from "@effect/atom-react";
import { folderStatusSummary } from "@t3tools/client-runtime/state/threadStatusLine";
import type { ReactElement } from "react";

import { folderStatusBreakdown } from "../sidebar/folders/folderStatus";
import { ThreadCount } from "../sidebar/folders/LevelRow";
import { folderStatusCountsAtom } from "../sidebar/folders/folderThreads";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface FolderStatus {
  /** "2 working · 1 waiting"; null while nothing in the folder moves. */
  readonly summary: string | null;
  /** Everything, idle included, for the folder name's tooltip. */
  readonly breakdown: string;
}

/** A folder's roll-up; null while no live thread is in it or below. */
export function useFolderStatus(folderNodeKey: string): FolderStatus | null {
  const counts = useAtomValue(folderStatusCountsAtom(folderNodeKey));
  return counts === null
    ? null
    : { summary: folderStatusSummary(counts), breakdown: folderStatusBreakdown(counts) };
}

/**
 * What a folder row shows at its end: the roll-up while threads work or wait,
 * otherwise the plain thread count. Quiet either way: project-level progress,
 * never who it waits on.
 */
export function FolderStatusCount(props: {
  readonly count: number;
  readonly status: FolderStatus | null;
}) {
  const summary = props.status?.summary ?? null;
  if (summary === null) return <ThreadCount count={props.count} />;
  return <span className="text-3xs tabular-nums text-sidebar-muted-foreground/50">{summary}</span>;
}

/** The full breakdown on the folder's name, pulled by hovering; the name alone without one. */
export function FolderStatusTooltip(props: {
  readonly status: FolderStatus | null;
  readonly children: ReactElement;
}) {
  if (props.status === null) return props.children;
  return (
    <Tooltip>
      <TooltipTrigger render={props.children} />
      <TooltipPopup side="right">{props.status.breakdown}</TooltipPopup>
    </Tooltip>
  );
}
