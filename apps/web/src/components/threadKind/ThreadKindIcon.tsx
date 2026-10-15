/**
 * signalbox: a sidebar row's kind (#46). The leading icon says chat or task
 * and is the toggle: one click flips it, with Undo in the sidebar. It takes
 * the row's quiet secondary color for both kinds, so rows recede by
 * attention, never by kind.
 */
import type { ThreadKind } from "@t3tools/contracts/signalboxThreadKinds";
import { ArchiveIcon, CheckIcon, ListTodoIcon, MessageCircleIcon } from "lucide-react";
import {
  memo,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { flipThreadKind, type ThreadKindState } from "../../state/signalboxThreadKinds";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  chatArchiveRowLabel,
  THREAD_KIND_LABEL,
  threadKindFlipLabel,
  threadKindSummary,
  threadLeaveLabel,
} from "./threadKind.logic";

export const THREAD_KIND_ICON = {
  chat: MessageCircleIcon,
  task: ListTodoIcon,
} as const satisfies Record<ThreadKind, unknown>;

/** The shared minute clock as epoch ms, for countdowns that move on their own. */
export function useNowMs(): number {
  return Date.parse(`${useNowMinute()}:00Z`);
}

/** Read when the tooltip opens; the minute clock keeps an open one current. */
function ThreadKindTooltipContent(props: { readonly kind: ThreadKindState }) {
  const nowMs = useNowMs();
  return (
    <span className="flex flex-col">
      <span>{threadKindSummary(props.kind, nowMs)}</span>
      {props.kind.canChange ? (
        <span className="text-muted-foreground">
          Click to {threadKindFlipLabel(props.kind.kind).toLowerCase()}
        </span>
      ) : null}
    </span>
  );
}

const stopPointer = (event: PointerEvent) => event.stopPropagation();

export const ThreadKindButton = memo(function ThreadKindButton(props: {
  readonly kind: ThreadKindState | null;
  readonly className?: string;
}) {
  const { kind } = props;
  if (kind === null) return null;
  const Icon = THREAD_KIND_ICON[kind.kind];
  const flip = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    void flipThreadKind(kind.threadRef, kind.kind);
  };
  // The row activates on Enter and Space; this button owns them while focused.
  const keepKeys = (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") event.stopPropagation();
  };
  const label = THREAD_KIND_LABEL[kind.kind];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          kind.canChange ? (
            <button
              type="button"
              aria-label={`${label}. ${threadKindFlipLabel(kind.kind)}`}
              data-thread-selection-safe
              className={cn(
                "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-secondary-label outline-hidden transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                props.className,
              )}
              onPointerDown={stopPointer}
              onClick={flip}
              onDoubleClick={(event) => event.stopPropagation()}
              onKeyDown={keepKeys}
            />
          ) : (
            <span
              role="img"
              aria-label={label}
              className={cn(
                "inline-flex size-5 shrink-0 items-center justify-center text-secondary-label",
                props.className,
              )}
            />
          )
        }
      >
        <Icon aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">
        <ThreadKindTooltipContent kind={kind} />
      </TooltipPopup>
    </Tooltip>
  );
});

function ChatArchiveCountdown(props: { readonly dueAtMs: number; readonly children: ReactNode }) {
  return chatArchiveRowLabel(props.dueAtMs, useNowMs()) ?? props.children;
}

/**
 * A row's age, or on a chat's last idle day when it archives itself. Only
 * chats that will archive keep a clock running.
 */
export function ThreadKindAge(props: {
  readonly kind: ThreadKindState | null;
  readonly children: ReactNode;
}) {
  const dueAtMs = props.kind?.archiveDueAtMs ?? null;
  if (dueAtMs === null) return props.children;
  return <ChatArchiveCountdown dueAtMs={dueAtMs}>{props.children}</ChatArchiveCountdown>;
}

/** The icon for how a thread leaves the list: Done for tasks, Archive otherwise. */
export function ThreadLeaveIcon(props: {
  readonly kind: ThreadKindState | null;
  readonly className?: string;
}) {
  const Icon = threadLeaveLabel(props.kind?.kind ?? null) === "Done" ? CheckIcon : ArchiveIcon;
  return <Icon className={props.className} />;
}
