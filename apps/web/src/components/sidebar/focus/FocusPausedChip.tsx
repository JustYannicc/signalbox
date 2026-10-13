/**
 * Top-of-tree reminder that Focus is hiding sections: "Work hidden". Out of
 * sight is out of mind, so it never says what's running or waiting in there.
 * Clicking peeks at the hidden sections without changing Focus; clicking
 * again tucks them away.
 */
import { EyeIcon, EyeOffIcon } from "lucide-react";

export function FocusPausedChip(props: {
  hiddenLabel: string;
  peeking: boolean;
  onTogglePeek: () => void;
}) {
  const Icon = props.peeking ? EyeOffIcon : EyeIcon;
  return (
    <div className="flex px-0.5 pt-3">
      <button
        type="button"
        aria-pressed={props.peeking}
        onClick={props.onTogglePeek}
        className="group/focus-chip inline-flex h-6 max-w-full cursor-pointer items-center gap-1.5 rounded-full border border-sidebar-border px-2.5 text-xs text-sidebar-muted-foreground outline-hidden ring-ring hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2"
      >
        <span className="min-w-0 truncate">
          {props.peeking ? `Showing ${props.hiddenLabel}` : `${props.hiddenLabel} hidden`}
        </span>
        <Icon className="size-3 shrink-0 opacity-0 group-hover/focus-chip:opacity-100 group-focus-visible/focus-chip:opacity-100" />
      </button>
    </div>
  );
}
