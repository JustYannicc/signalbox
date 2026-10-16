/**
 * signalbox: a thread's branch where nobody picks it. An environment without `worktrees`
 * (Signalbox Cloud) gives each thread its own branch, so Thread details and the composer strip
 * show it read-only, with no ref search, create or checkout. A draft shows the branch its
 * thread will start from.
 */
import { GitBranchIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { ComposerContextLabel } from "../ComposerContextLabel";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
} from "../chat/threadDetailsPanelStyles";
import { MiddleTruncate } from "../ui/middle-truncate";

export function ownBranchLabel(branch: string | null, isDraft: boolean): string | null {
  if (branch === null) return null;
  return isDraft ? `From ${branch}` : branch;
}

export function OwnBranchLabel({
  displayMode,
  label,
}: {
  readonly displayMode: "toolbar" | "panel";
  readonly label: string;
}) {
  const isPanel = displayMode === "panel";
  return (
    <span
      className={
        isPanel
          ? cn(THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS, "flex items-center")
          : "inline-flex h-7 min-w-0 max-w-full items-center gap-1 px-1.75 font-normal text-muted-foreground/70 text-xs sm:h-6"
      }
    >
      <GitBranchIcon
        aria-hidden
        className={isPanel ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3 shrink-0 opacity-70"}
      />
      <ComposerContextLabel displayMode={displayMode}>
        <MiddleTruncate
          value={label}
          variant={isPanel ? "cap-aligned" : "default"}
          className="w-full"
        />
      </ComposerContextLabel>
    </span>
  );
}
