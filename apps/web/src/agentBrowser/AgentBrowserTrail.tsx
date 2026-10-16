import {
  agentBrowserPlaceLabel,
  agentBrowserStepLabel,
  agentBrowserStepTime,
} from "@t3tools/client-runtime/state/signalboxAgentBrowserFrame";
import type { AgentBrowserStep } from "@t3tools/contracts/signalboxPreviews";
import { memo, useEffect, useRef } from "react";

import { cn } from "~/lib/utils";

/**
 * Every finished step of the agent's browsing, oldest first. Picking one shows
 * the page as that step left it. Follows new steps while scrolled to the end.
 */
export const AgentBrowserTrail = memo(function AgentBrowserTrail(props: {
  readonly steps: ReadonlyArray<AgentBrowserStep>;
  /** The step the frame shows, live or picked. */
  readonly shownStepId: string | null;
  readonly onSelect: (stepId: string) => void;
}) {
  const listRef = useRef<HTMLOListElement>(null);
  const pinnedToEndRef = useRef(true);
  const count = props.steps.length;

  useEffect(() => {
    const list = listRef.current;
    if (list && count > 0 && pinnedToEndRef.current) list.scrollTop = list.scrollHeight;
  }, [count]);

  return (
    <section aria-label="Steps" className="flex max-h-44 min-h-0 shrink-0 flex-col border-t">
      <h3 className="px-3 pt-2 pb-1 font-medium text-muted-foreground text-xs">
        Steps <span className="tabular-nums">{count}</span>
      </h3>
      <ol
        ref={listRef}
        className="min-h-0 overflow-y-auto px-1.5 pb-1.5"
        onScroll={(event) => {
          const list = event.currentTarget;
          pinnedToEndRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 8;
        }}
      >
        {props.steps.map((step) => {
          const shown = step.stepId === props.shownStepId;
          return (
            <li key={step.stepId}>
              <button
                type="button"
                aria-current={shown ? "step" : undefined}
                onClick={() => props.onSelect(step.stepId)}
                className={cn(
                  "flex w-full min-w-0 items-baseline gap-2 rounded-md px-1.5 py-1 text-left text-xs outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                  shown && "bg-accent",
                )}
              >
                <span className="shrink-0 text-foreground">
                  {agentBrowserStepLabel(step.action)}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {agentBrowserPlaceLabel(step.title, step.url, step.url)}
                </span>
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  {agentBrowserStepTime(step.endedAt)}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
});
