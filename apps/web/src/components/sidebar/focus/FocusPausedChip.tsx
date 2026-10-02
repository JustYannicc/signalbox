/**
 * Top-of-tree reminder that Focus is hiding sections: "Work hidden · 2
 * running". Clicking peeks at the hidden sections without changing Focus;
 * clicking again tucks them away.
 */
import { EyeIcon, EyeOffIcon, LoaderCircleIcon } from "lucide-react";

export function FocusPausedChip(props: {
  hiddenLabel: string;
  runningCount: number;
  peeking: boolean;
  onTogglePeek: () => void;
}) {
  const Icon = props.peeking ? EyeOffIcon : EyeIcon;
  const running = props.runningCount > 0 ? ` · ${props.runningCount} running` : "";
  return (
    <div className="flex px-0.5 pt-3">
      <button
        type="button"
        aria-pressed={props.peeking}
        onClick={props.onTogglePeek}
        className="group/focus-chip inline-flex h-6 max-w-full cursor-pointer items-center gap-1.5 rounded-full border border-sidebar-border px-2.5 text-xs text-sidebar-muted-foreground outline-hidden ring-ring hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2"
      >
        {props.runningCount > 0 ? (
          <LoaderCircleIcon aria-hidden className="size-3 shrink-0" />
        ) : null}
        <span className="min-w-0 truncate">
          {props.peeking ? `Showing ${props.hiddenLabel}` : `${props.hiddenLabel} hidden`}
          {running}
        </span>
        <Icon className="size-3 shrink-0 opacity-0 group-hover/focus-chip:opacity-100 group-focus-visible/focus-chip:opacity-100" />
      </button>
    </div>
  );
}
