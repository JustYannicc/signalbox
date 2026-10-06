/**
 * Draws a laid-out automation top to bottom: container boxes underneath, then
 * the connecting lines with their option labels, then the cards. With a run,
 * taken lines go solid and the rest dash and fade.
 */
import { roundedPath, type DiagramRun } from "@t3tools/client-runtime/automations/diagram";
import type { LayoutEdge, WorkflowLayout } from "@t3tools/client-runtime/automations/layout";
import type { LucideIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { DiagramCard, DiagramContainer, type CardRunView } from "./DiagramCards";

const CORNER = 8;

type EdgeTone = "neutral" | "taken" | "skipped" | "failure";

const STROKE: Record<EdgeTone, string> = {
  neutral: "stroke-muted-foreground/45",
  taken: "stroke-foreground/70",
  skipped: "stroke-muted-foreground/30",
  failure: "stroke-destructive/60",
};
const FILL: Record<EdgeTone, string> = {
  neutral: "fill-muted-foreground/45",
  taken: "fill-foreground/70",
  skipped: "fill-muted-foreground/30",
  failure: "fill-destructive/60",
};

function edgeTone(edge: LayoutEdge, run: DiagramRun | null): EdgeTone {
  const state = run?.edges.get(edge.id) ?? "plain";
  if (state === "untaken") return "skipped";
  if (edge.failure) return "failure";
  return state === "taken" ? "taken" : "neutral";
}

const EdgeLayer = memo(function EdgeLayer(props: {
  layout: WorkflowLayout;
  run: DiagramRun | null;
}) {
  const { layout, run } = props;
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-visible"
      width={layout.width}
      height={layout.height}
    >
      <defs>
        {(Object.keys(STROKE) as EdgeTone[]).map((tone) => (
          <marker
            key={tone}
            id={`automation-arrow-${tone}`}
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto"
          >
            <path d="M 0 0.5 L 7.5 4 L 0 7.5 z" className={FILL[tone]} />
          </marker>
        ))}
      </defs>
      {layout.edges.map((edge, index) => {
        const tone = edgeTone(edge, run);
        return (
          <path
            // Edge ids can repeat across decisions that share option names.
            // oxlint-disable-next-line react/no-array-index-key -- one edge can carry several labels; id plus position is stable for a given layout
            key={`${edge.id}:${index}`}
            d={roundedPath(edge.points, CORNER)}
            fill="none"
            strokeWidth={tone === "taken" ? 2 : 1.5}
            strokeDasharray={tone === "skipped" || edge.failure ? "4 4" : undefined}
            strokeLinejoin="round"
            className={STROKE[tone]}
            // Lines end with an arrowhead only where they enter something; joins meet mid-air.
            markerEnd={edge.to !== null ? `url(#automation-arrow-${tone})` : undefined}
          />
        );
      })}
    </svg>
  );
});

function EdgeLabels(props: { layout: WorkflowLayout; run: DiagramRun | null }) {
  return props.layout.edges.map((edge, index) => {
    if (!edge.label || !edge.labelAt) return null;
    const state = props.run?.edges.get(edge.id);
    return (
      <span
        // oxlint-disable-next-line react/no-array-index-key -- an edge can carry several labels; its id plus position is stable within one layout
        key={`${edge.id}:${index}`}
        className={cn(
          "pointer-events-none absolute max-w-40 -translate-x-1/2 truncate rounded-full border bg-background px-2 text-2xs leading-4.5",
          edge.failure ? "text-destructive-foreground" : "text-foreground",
          state === "taken" && "border-foreground/30 font-medium",
          state === "untaken" && "border-dashed opacity-50",
        )}
        style={{ left: edge.labelAt.x, top: edge.labelAt.y + 1 }}
      >
        {edge.label}
      </span>
    );
  });
}

const NO_RUN: CardRunView = { active: false, reached: true, state: null };

export const WorkflowDiagram = memo(function WorkflowDiagram(props: {
  layout: WorkflowLayout;
  run: DiagramRun | null;
  selectedId: string | null;
  triggerIcon: LucideIcon;
  onSelect: (id: string) => void;
}) {
  const { layout, run } = props;
  const runView = (id: string): CardRunView =>
    run
      ? { active: true, reached: run.reached.has(id), state: run.states.get(id) ?? null }
      : NO_RUN;
  return (
    <div className="relative" style={{ width: layout.width, height: layout.height }}>
      {layout.containers.map((container) => (
        <DiagramContainer
          key={container.id}
          container={container}
          run={runView(container.id)}
          progress={run?.loops.get(container.id) ?? null}
          selected={props.selectedId === container.id}
          onSelect={props.onSelect}
        />
      ))}
      <EdgeLayer layout={layout} run={run} />
      <EdgeLabels layout={layout} run={run} />
      {layout.cards.map((card) => (
        <DiagramCard
          key={card.id}
          card={card}
          run={runView(card.id)}
          selected={props.selectedId === card.id}
          triggerIcon={props.triggerIcon}
          onSelect={props.onSelect}
        />
      ))}
    </div>
  );
});
