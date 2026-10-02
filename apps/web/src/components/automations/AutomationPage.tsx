/**
 * One automation: its workflow graph or the TypeScript source it is derived
 * from. A picked run (`?run=`) opens as its chat; `&show=workflow` shows that
 * run's step results on the canvas instead. Changes go through the workflow
 * agent. Prototype only: placeholder fixtures, nothing is edited.
 */
import { Link, useNavigate } from "@tanstack/react-router";
import { HistoryIcon, MessageSquareIcon, PlayIcon, XIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { isElectron } from "../../env";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { AutomationActionsMenu } from "./AutomationActionsMenu";
import { AutomationRunChat } from "./AutomationRunChat";
import { formatRunStarted } from "./automationFormat";
import { maxIterations, type Automation, type AutomationRun } from "./automationModel";
import { runDisplayStatus } from "./automationStatus";
import { useAutomation } from "./runDecisions";
import { notifyAutomationsComingSoon } from "./comingSoon";
import { RunStatusMarker } from "./RunStatusMarker";
import { useAssistantName } from "./useAssistantName";
import { WorkflowAgentButton } from "./WorkflowAgent";
import { WorkflowCanvas } from "./WorkflowCanvas";
import { WorkflowNodeDetails } from "./WorkflowNodeDetails";
import { WorkflowSourceView } from "./WorkflowSourceView";

type AutomationTab = "workflow" | "source";

/** The step a run needs you to look at: where it failed or what waits on you. */
function attentionNodeId(run: AutomationRun | null) {
  if (!run) return null;
  const entry = Object.entries(run.nodes).find(
    ([, result]) => result.status === "failed" || result.status === "waiting",
  );
  return entry?.[0] ?? null;
}

/** Only scheduled workflows can simply run again; event-driven ones replay a past run. */
function canRunNow(automation: Automation) {
  return automation.nodes.some(
    (node) => node.config.kind === "trigger" && node.config.source === "schedule",
  );
}

function SelectedRunChip(props: {
  run: AutomationRun;
  onOpenChat: () => void;
  onClear: () => void;
}) {
  const nameText = useAssistantName();
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border bg-card py-0.5 pr-0.5 pl-2 text-xs">
      <RunStatusMarker status={runDisplayStatus(props.run)} />
      <span className="min-w-0 truncate text-foreground">{nameText(props.run.title)}</span>
      <span className="shrink-0 text-muted-foreground">{formatRunStarted(props.run)}</span>
      <Button
        variant="ghost-muted"
        size="icon-micro"
        aria-label="Open run chat"
        onClick={props.onOpenChat}
      >
        <MessageSquareIcon />
      </Button>
      <Button
        variant="ghost-muted"
        size="icon-micro"
        aria-label="Clear selected run"
        onClick={props.onClear}
      >
        <XIcon />
      </Button>
    </div>
  );
}

function PauseSwitch(props: { automation: Automation }) {
  const [enabled, setEnabled] = useState(props.automation.enabled);
  const { system } = props.automation;
  const control = (
    <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground has-disabled:cursor-not-allowed">
      <Switch
        size="sm"
        checked={enabled}
        disabled={system !== undefined}
        onCheckedChange={setEnabled}
      />
      {enabled ? "On" : "Paused"}
    </label>
  );
  if (!system) return control;
  return (
    <Tooltip>
      <TooltipTrigger render={<span />}>{control}</TooltipTrigger>
      <TooltipPopup side="bottom">Always on: {system.reason}</TooltipPopup>
    </Tooltip>
  );
}

export function AutomationPage(props: {
  automationId: string;
  runId: string | null;
  showRunOnWorkflow: boolean;
}) {
  const navigate = useNavigate();
  const nameText = useAssistantName();
  const automation = useAutomation(props.automationId);
  const run = automation?.runs.find((candidate) => candidate.id === props.runId) ?? null;
  const runChat = run !== null && !props.showRunOnWorkflow;
  const [tab, setTab] = useState<AutomationTab>("workflow");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(() => attentionNodeId(run));

  // A run newly shown on the workflow opens with its failing or waiting step inspected.
  const shownKey = run && props.showRunOnWorkflow ? run.id : null;
  const [shownRunId, setShownRunId] = useState(shownKey);
  if (shownKey !== shownRunId) {
    setShownRunId(shownKey);
    if (run && shownKey) {
      setTab("workflow");
      const nodeId = attentionNodeId(run);
      if (nodeId) setSelectedNodeId(nodeId);
    }
  }

  const go = useCallback(
    (search: { run?: string; show?: "workflow" }) => {
      void navigate({
        to: "/automations/$automationId",
        params: { automationId: props.automationId },
        search,
      });
    },
    [navigate, props.automationId],
  );

  if (!automation) {
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden">
        <WorkspacePageHeader electron={isElectron} />
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="text-sm font-medium text-foreground">Automation not found</p>
          <Link
            to="/automations"
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            Back to Automations
          </Link>
        </div>
      </SidebarInset>
    );
  }

  const selectedNode = automation.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const canvasRun = runChat ? null : run;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Automation breadcrumb" className="min-w-0 shrink">
            <WorkspaceBreadcrumbItem>
              <Link to="/automations" className="hover:text-foreground">
                <WorkspaceBreadcrumbText>Automations</WorkspaceBreadcrumbText>
              </Link>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current className="min-w-10">
              <h1 className="min-w-0">
                <WorkspaceBreadcrumbText>{nameText(automation.name)}</WorkspaceBreadcrumbText>
              </h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <WorkflowAgentButton automation={automation} />
          {canvasRun ? (
            <div className="hidden min-w-0 md:flex">
              <SelectedRunChip
                run={canvasRun}
                onOpenChat={() => go({ run: canvasRun.id })}
                onClear={() => go({})}
              />
            </div>
          ) : null}
          <div className="ms-auto flex shrink-0 items-center gap-3">
            <ToggleGroup
              aria-label="Automation view"
              variant="segmented"
              value={runChat ? [] : [tab]}
              onValueChange={(next) => {
                const value = next[0];
                if (value !== "workflow" && value !== "source") return;
                setTab(value);
                if (runChat) go({});
              }}
            >
              <Toggle value="workflow">Workflow</Toggle>
              <Toggle value="source">Source</Toggle>
            </ToggleGroup>
            <PauseSwitch automation={automation} />
            {canRunNow(automation) ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => notifyAutomationsComingSoon("Run now")}
              >
                <PlayIcon />
                Run now
              </Button>
            ) : (
              <Button
                size="xs"
                variant="outline"
                disabled={automation.runs.length === 0}
                onClick={() => notifyAutomationsComingSoon("Replaying a run")}
              >
                <HistoryIcon />
                Replay a past run
              </Button>
            )}
            <AutomationActionsMenu automation={automation} />
          </div>
        </WorkspacePageHeader>

        <div className="flex min-h-0 flex-1 border-t">
          {runChat && run ? (
            <AutomationRunChat
              automation={automation}
              run={run}
              onShowOnWorkflow={() => go({ run: run.id, show: "workflow" })}
            />
          ) : tab === "source" ? (
            <WorkflowSourceView automation={automation} />
          ) : (
            <>
              <WorkflowCanvas
                automation={automation}
                run={canvasRun}
                selectedNodeId={selectedNodeId}
                onSelectNode={setSelectedNodeId}
              />
              {selectedNode ? (
                <WorkflowNodeDetails
                  node={selectedNode}
                  run={canvasRun}
                  maxIterations={maxIterations(automation.nodes)}
                  onClose={() => setSelectedNodeId(null)}
                />
              ) : null}
            </>
          )}
        </div>
      </div>
    </SidebarInset>
  );
}
