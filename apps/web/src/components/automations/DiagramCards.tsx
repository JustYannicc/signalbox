/**
 * The pieces of an automation diagram, absolutely positioned from the shared
 * layout: the trigger, step and decision cards, end markers, and the boxes
 * around loops, parallel groups and try blocks. With a run selected each piece
 * shows how far the run got; parts it never reached fade back.
 */
import { stepTypeLabel } from "@t3tools/client-runtime/automations/labels";
import type { LayoutCard, LayoutContainer } from "@t3tools/client-runtime/automations/layout";
import type { NodeRunState } from "@t3tools/client-runtime/automations/runState";
import {
  DISPLAY_STATUS_LABEL,
  stepDisplayStatus,
  type AutomationDisplayStatus,
} from "@t3tools/client-runtime/automations/status";
import {
  Columns3Icon,
  RepeatIcon,
  ShieldAlertIcon,
  SplitIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, type CSSProperties, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { StepTile } from "./nodeVisuals";
import { StatusIcon } from "./RunStatus";

export interface CardRunView {
  /** A run is selected, so unreached parts fade. */
  readonly active: boolean;
  readonly reached: boolean;
  readonly state: NodeRunState | null;
}

const box = (item: { x: number; y: number; width: number; height: number }): CSSProperties => ({
  left: item.x,
  top: item.y,
  width: item.width,
  height: item.height,
});

function runFrameClass(
  run: CardRunView,
  selected: boolean,
  status: AutomationDisplayStatus | null = null,
) {
  if (selected) return "border-primary ring-2 ring-primary/20";
  if (run.active && !run.reached) return "border-dashed border-border opacity-50";
  if (status === "failed") return "border-destructive/60";
  if (status === "needsYou") return "border-warning/60";
  if (status === "working") return "border-info/50";
  return "border-border";
}

/** Status in the card's corner, plus "×3" when a loop ran the step more than once. */
function RunMarkers(props: { status: AutomationDisplayStatus; runs: number }) {
  return (
    <>
      <span
        aria-hidden
        className="absolute -top-2 -right-2 flex size-5 items-center justify-center rounded-full bg-card ring-1 ring-border"
      >
        <StatusIcon status={props.status} className="size-3.5" />
      </span>
      {props.runs > 1 ? (
        <span
          aria-hidden
          className="absolute right-3 -bottom-2 rounded-full bg-card px-1.5 text-3xs leading-4 text-muted-foreground tabular-nums ring-1 ring-border"
        >
          ×{props.runs}
        </span>
      ) : null}
    </>
  );
}

function CardButton(props: {
  card: LayoutCard;
  label: string;
  selected: boolean;
  className: string;
  onSelect: (id: string) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-workflow-node
      aria-pressed={props.selected}
      aria-label={props.label}
      onClick={() => props.onSelect(props.card.id)}
      className={cn(
        "absolute flex cursor-pointer items-center border bg-card text-left shadow-sm/5 outline-none transition-[border-color,box-shadow,opacity] duration-150 hover:border-foreground/25 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        props.className,
      )}
      style={box(props.card)}
    >
      {props.children}
    </button>
  );
}

export const DiagramCard = memo(function DiagramCard(props: {
  card: LayoutCard;
  run: CardRunView;
  selected: boolean;
  triggerIcon: LucideIcon;
  onSelect: (id: string) => void;
}) {
  const { card, run, selected } = props;
  switch (card.kind) {
    case "trigger":
      return (
        <CardButton
          card={card}
          label={`Trigger: ${card.label}`}
          selected={selected}
          onSelect={props.onSelect}
          className={cn("gap-2.5 rounded-xl px-3", runFrameClass(run, selected))}
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-info/12 text-info-foreground">
            <props.triggerIcon aria-hidden className="size-4" />
          </span>
          <span className="min-w-0 truncate text-sm font-medium text-foreground">{card.label}</span>
        </CardButton>
      );
    case "step": {
      const status = run.state
        ? stepDisplayStatus({ status: run.state.status, verb: card.node.verb })
        : null;
      return (
        <CardButton
          card={card}
          label={`${card.node.label.text}${status ? `, ${DISPLAY_STATUS_LABEL[status]}` : ""}`}
          selected={selected}
          onSelect={props.onSelect}
          className={cn("gap-3 rounded-xl px-3", runFrameClass(run, selected, status))}
        >
          <StepTile node={card.node} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-2xs text-muted-foreground">
              {stepTypeLabel(card.node)}
            </span>
            <span className="truncate text-sm font-medium text-foreground">
              {card.node.label.text}
            </span>
          </span>
          {status && run.state ? <RunMarkers status={status} runs={run.state.runs} /> : null}
        </CardButton>
      );
    }
    case "decision":
      return (
        <CardButton
          card={card}
          label={`Decision: ${card.node.label.text}`}
          selected={selected}
          onSelect={props.onSelect}
          className={cn("gap-3 rounded-full pr-5 pl-3", runFrameClass(run, selected))}
        >
          {/* The diamond is what tells a decision from a step at a glance. */}
          <span className="flex size-7 shrink-0 rotate-45 items-center justify-center rounded-md bg-foreground text-background">
            <SplitIcon aria-hidden className="size-3.5 -rotate-45" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-2xs text-muted-foreground">
              {card.node.source === "outcome" ? "Depends on the answer" : "Decision"}
            </span>
            <span className="truncate text-sm font-medium text-foreground">
              {card.node.label.text}
            </span>
          </span>
        </CardButton>
      );
    case "end":
      return (
        <span
          className={cn(
            "absolute flex items-center justify-center rounded-full border bg-muted text-2xs font-medium text-muted-foreground",
            run.active && !run.reached ? "border-dashed opacity-50" : "border-border",
          )}
          style={box(card)}
        >
          {card.done ? "Done" : "End"}
        </span>
      );
  }
});

const CONTAINER_ICON: Record<LayoutContainer["kind"], LucideIcon> = {
  each: RepeatIcon,
  repeat: RepeatIcon,
  for: RepeatIcon,
  while: RepeatIcon,
  parallel: Columns3Icon,
  try: ShieldAlertIcon,
};

export const DiagramContainer = memo(function DiagramContainer(props: {
  container: LayoutContainer;
  run: CardRunView;
  progress: string | null;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const { container, run } = props;
  const Icon = CONTAINER_ICON[container.kind];
  return (
    <div
      className={cn(
        "absolute rounded-2xl border bg-muted/30 transition-[border-color,opacity] duration-150",
        props.selected ? "border-primary/60" : "border-border/80",
        run.active && !run.reached && "border-dashed opacity-50",
      )}
      style={box(container)}
    >
      <button
        type="button"
        data-workflow-node
        aria-pressed={props.selected}
        onClick={() => props.onSelect(container.id)}
        className="flex h-8 w-full cursor-pointer items-center gap-1.5 rounded-t-2xl px-3 text-left text-xs outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-medium text-foreground">{container.label}</span>
        {container.detail ? (
          <span className="shrink-0 text-muted-foreground">· {container.detail}</span>
        ) : null}
        {props.progress ? (
          <span className="ms-auto shrink-0 rounded-full bg-background px-1.5 text-2xs leading-4 font-medium text-foreground tabular-nums ring-1 ring-border">
            {props.progress}
          </span>
        ) : null}
      </button>
    </div>
  );
});
