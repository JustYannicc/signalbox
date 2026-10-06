/**
 * The diagram surface: a dotted grid that pans and zooms with the diagram,
 * plus zoom controls in the corner. Clicking the background clears the
 * selection. `topLeft` holds the run picker.
 */
import type { DiagramRun } from "@t3tools/client-runtime/automations/diagram";
import type { WorkflowLayout } from "@t3tools/client-runtime/automations/layout";
import type { LucideIcon } from "lucide-react";
import { MaximizeIcon, MinusIcon, PlusIcon } from "lucide-react";
import { useRef, type ReactNode } from "react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useCanvasViewport } from "./useCanvasViewport";
import { WorkflowDiagram } from "./WorkflowDiagram";

const GRID_SIZE = 20;

function CanvasControl(props: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost-muted"
            size="icon-xs"
            aria-label={props.label}
            onClick={props.onClick}
          >
            {props.children}
          </Button>
        }
      />
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

export function WorkflowCanvas(props: {
  name: string;
  layout: WorkflowLayout;
  run: DiagramRun | null;
  selectedId: string | null;
  triggerIcon: LucideIcon;
  onSelect: (id: string | null) => void;
  topLeft?: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { viewport, fit, zoomIn, zoomOut, canvasHandlers } = useCanvasViewport(
    containerRef,
    props.layout,
    () => props.onSelect(null),
  );
  const gridStep = GRID_SIZE * viewport.zoom;

  return (
    <div
      ref={containerRef}
      role="application"
      aria-label={`${props.name} diagram`}
      className="relative min-h-0 min-w-0 flex-1 cursor-grab touch-none overflow-hidden bg-background select-none active:cursor-grabbing"
      style={{
        backgroundImage:
          "radial-gradient(circle, color-mix(in srgb, var(--contrast-muted-foreground) 28%, transparent) 1px, transparent 1.5px)",
        backgroundSize: `${gridStep}px ${gridStep}px`,
        backgroundPosition: `${viewport.x}px ${viewport.y}px`,
      }}
      {...canvasHandlers}
    >
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` }}
      >
        <WorkflowDiagram
          layout={props.layout}
          run={props.run}
          selectedId={props.selectedId}
          triggerIcon={props.triggerIcon}
          onSelect={props.onSelect}
        />
      </div>

      {props.topLeft ? (
        <div data-canvas-control className="absolute top-3 left-3 cursor-default">
          {props.topLeft}
        </div>
      ) : null}
      <div
        data-canvas-control
        className="absolute bottom-3 left-3 flex cursor-default items-center gap-0.5 rounded-lg border bg-card p-0.5 shadow-sm/5"
      >
        <CanvasControl label="Zoom out" onClick={zoomOut}>
          <MinusIcon />
        </CanvasControl>
        <span className="w-10 text-center text-2xs text-muted-foreground tabular-nums">
          {Math.round(viewport.zoom * 100)}%
        </span>
        <CanvasControl label="Zoom in" onClick={zoomIn}>
          <PlusIcon />
        </CanvasControl>
        <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
        <CanvasControl label="Fit to view" onClick={fit}>
          <MaximizeIcon />
        </CanvasControl>
      </div>
      <p className="pointer-events-none absolute right-3 bottom-3.5 hidden text-2xs text-muted-foreground/70 md:block">
        Drag to pan · ⌘ scroll to zoom
      </p>
    </div>
  );
}
