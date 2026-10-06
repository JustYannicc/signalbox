/**
 * The automation page's diagram: the canvas with the run picker and the
 * add-step palette, and the details panel. A run that needs you, or failed,
 * opens with that step selected so the answer or the error is one glance away.
 */
import type {
  AutomationDetail,
  AutomationDraft,
  AutomationRunDetail,
  AutomationRunSummary,
  EnvironmentId,
} from "@t3tools/contracts";
import { diagramRun } from "@t3tools/client-runtime/automations/diagram";
import { layoutWorkflow } from "@t3tools/client-runtime/automations/layout";
import { triggerSummary } from "@t3tools/client-runtime/automations/triggers";
import type { LucideIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { AddStepPalette } from "./AddStepPalette";
import { NodeDetailsPanel } from "./NodeDetailsPanel";
import { RunPicker } from "./RunPicker";
import { WorkflowCanvas } from "./WorkflowCanvas";

function CanvasNote(props: { children: string }) {
  return (
    <p className="rounded-md bg-card px-2 py-1 text-2xs text-muted-foreground ring-1 ring-border">
      {props.children}
    </p>
  );
}

export function AutomationWorkspace(props: {
  environmentId: EnvironmentId;
  detail: AutomationDetail;
  /** The run drawn over the diagram, once it loaded. */
  runDetail: AutomationRunDetail | null;
  selectedRun: AutomationRunSummary | null;
  /** Why the run picked in the URL couldn't load. */
  runError: string | null;
  triggerIcon: LucideIcon;
  onSelectRun: (runId: string) => void;
  onOpenRunChat: (runId: string) => void;
  onShowLine: (line: number) => void;
  /** A draft to draw instead of the live version; runs don't show on it. */
  draft?: AutomationDraft | null;
}) {
  const { detail, environmentId } = props;
  const { automation } = detail;
  const draft = props.draft ?? null;
  const runDetail = draft ? null : props.runDetail;

  // A run draws on the graph of the version it ran.
  const graph = draft?.graph ?? runDetail?.graph ?? detail.graph;
  const version = draft?.version ?? runDetail?.run.version ?? automation.version;
  const trigger = triggerSummary(automation.triggers);
  // Live updates bring a new graph object every time, but a version's graph never changes.
  const pictureKey = `${automation.id}:${version}:${trigger}`;
  const [picture, setPicture] = useState(() => ({
    key: pictureKey,
    layout: layoutWorkflow(graph, trigger),
  }));
  let layout = picture.layout;
  if (picture.key !== pictureKey) {
    layout = layoutWorkflow(graph, trigger);
    setPicture({ key: pictureKey, layout });
  }
  const run = useMemo(
    () => (runDetail ? diagramRun(layout, graph, runDetail) : null),
    [graph, layout, runDetail],
  );

  // A run that needs you, or failed, opens with that step selected.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [attendedRunId, setAttendedRunId] = useState<string | null>(null);
  if (runDetail && run && runDetail.run.id !== attendedRunId) {
    setAttendedRunId(runDetail.run.id);
    if (run.focus?.status === "needsYou" || run.focus?.status === "failed") {
      setSelectedId(run.focus.id);
    }
  }

  return (
    <div className="relative flex min-h-0 flex-1">
      <WorkflowCanvas
        // A new version is a new picture; fit it again.
        key={`${automation.id}:${version}`}
        name={automation.name}
        layout={layout}
        run={run}
        selectedId={selectedId}
        triggerIcon={props.triggerIcon}
        onSelect={setSelectedId}
        topLeft={
          draft ? (
            <CanvasNote>{`Draft version ${draft.version}. Runs show on the live version.`}</CanvasNote>
          ) : (
            <div className="flex flex-col items-start gap-1.5">
              <div className="flex flex-wrap items-start gap-1.5">
                <RunPicker
                  environmentId={environmentId}
                  latestVersion={automation.version}
                  runs={detail.runs}
                  selected={props.selectedRun}
                  onSelect={props.onSelectRun}
                  onOpenChat={props.onOpenRunChat}
                />
                <AddStepPalette environmentId={environmentId} automation={automation} />
              </div>
              {runDetail && runDetail.run.version !== automation.version ? (
                <CanvasNote>This run used an earlier version of the automation.</CanvasNote>
              ) : null}
              {props.runError ? (
                <CanvasNote>{`Couldn't load that run. ${props.runError}`}</CanvasNote>
              ) : null}
            </div>
          )
        }
      />
      {selectedId ? (
        <NodeDetailsPanel
          key={selectedId}
          environmentId={environmentId}
          selectedId={selectedId}
          graph={graph}
          layout={layout}
          triggers={automation.triggers}
          run={runDetail}
          diagram={run}
          onShowLine={props.onShowLine}
          onClose={() => setSelectedId(null)}
        />
      ) : null}
    </div>
  );
}
