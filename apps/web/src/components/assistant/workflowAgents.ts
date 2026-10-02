/**
 * PLACEHOLDER workflow agents: every automation gets a supervisor that runs it
 * and speaks up only when something needs the user. Built from the automation
 * fixtures (read-only). A run starts at the automation's trigger, not at the
 * assistant: trigger → workflow agent → the run's thread. Like the other
 * supervisors, a workflow agent's chat closes once its open runs are done.
 */
import { ProviderDriverKind } from "@t3tools/contracts";

import { AUTOMATIONS, findAutomation } from "../automations/automationFixtures";
import type {
  Automation,
  AutomationRun,
  AutomationRunStatus,
  AutomationRunTrigger,
} from "../automations/automationModel";
import type { AgentFixture } from "./agentFixtures";
import type {
  AssistantBlock,
  DelegationFixture,
  DelegationStatus,
  TraceNodeFixture,
  TurnFixture,
} from "./assistantFixtures";

const STATUS: Record<AutomationRunStatus, DelegationStatus> = {
  success: "done",
  failed: "failed",
  running: "working",
  waiting: "approval",
};

const TRIGGER_LABEL: Record<AutomationRunTrigger, string> = {
  schedule: "Schedule",
  webhook: "Webhook",
  event: "Event",
  device: "Device signal",
  manual: "Started by you",
  hook: "Hook",
};

const timeFormatter = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

export const workflowNodeId = (automationId: string) => `workflow:${automationId}`;
const triggerNodeId = (automationId: string) => `trigger:${automationId}`;
const runNodeId = (runId: string) => `thread:run-${runId}`;
const runDelegationId = (runId: string) => `d-run-${runId}`;

const latestRun = (automation: Automation): AutomationRun | undefined => automation.runs[0];
const isOpen = (run: AutomationRun) => run.status !== "success";

export const WORKFLOW_NODES: readonly TraceNodeFixture[] = AUTOMATIONS.flatMap((automation) => {
  const run = latestRun(automation);
  const nodes: TraceNodeFixture[] = [
    {
      id: workflowNodeId(automation.id),
      kind: "workflow",
      name: automation.agentName,
      path: ["Automations"],
    },
  ];
  if (!run) return nodes;
  return [
    ...nodes,
    {
      id: triggerNodeId(automation.id),
      kind: "trigger",
      name: `${TRIGGER_LABEL[run.trigger]} · ${automation.name}`,
      path: ["Automations"],
    },
    {
      id: runNodeId(run.id),
      kind: "thread",
      name: run.title,
      path: ["Automations", automation.name],
      threadKind: "task",
      harness: ProviderDriverKind.make("codex"),
    },
  ];
});

export const WORKFLOW_DELEGATIONS: readonly DelegationFixture[] = AUTOMATIONS.flatMap(
  (automation) => {
    const run = latestRun(automation);
    if (!run) return [];
    const at = timeFormatter.format(new Date(run.startedAt));
    const status = STATUS[run.status];
    return [
      {
        id: runDelegationId(run.id),
        origin: triggerNodeId(automation.id),
        at,
        status,
        summary: `run “${automation.name}”`,
        message: `${TRIGGER_LABEL[run.trigger]}: run ${automation.name}.`,
        groupId: "",
        hops: [
          {
            to: workflowNodeId(automation.id),
            at,
            status: "done",
            message: `${TRIGGER_LABEL[run.trigger]} fired (${automation.cadence}).`,
          },
          { to: runNodeId(run.id), at, status, message: `Run ${automation.name}.` },
        ],
        statusDetail: automation.cadence,
      },
    ];
  },
);

function openSummary(open: readonly AutomationRun[]): string {
  const count = (status: AutomationRunStatus) => open.filter((run) => run.status === status).length;
  const parts = [
    count("waiting") > 0 ? `${count("waiting")} waiting on your approval` : null,
    count("failed") > 0 ? `${count("failed")} failed` : null,
    count("running") > 0 ? `${count("running")} still running` : null,
  ].filter(Boolean);
  return `Open runs: ${parts.join(", ")}.`;
}

/** Whether open runs were worth a ping: approvals go to the phone, failures get a badge. */
function openNotice(automation: Automation, open: readonly AutomationRun[]): AssistantBlock {
  const nodeId = workflowNodeId(automation.id);
  if (open.some((run) => run.status === "waiting")) {
    return {
      kind: "notification",
      delivery: "phone",
      reason: "urgent: approval needed",
      nodeId,
      detail: "A run is blocked on an approval only you can give, and you were away.",
    };
  }
  if (open.some((run) => run.status === "failed")) {
    return {
      kind: "notification",
      delivery: "computer",
      reason: "a run failed",
      nodeId,
      detail: "Something broke, but it isn't blocking you, so it's a quiet badge.",
    };
  }
  return {
    kind: "notification",
    delivery: "none",
    reason: "still running, nothing needs you",
    nodeId,
    detail: "Running work stays in this chat until something needs you.",
  };
}

const linkBlock = (automation: Automation): AssistantBlock => ({
  kind: "automation",
  automationId: automation.id,
  label: automation.name,
});

/** The workflow agent for `workflow-<automationId>`, or null when no automation matches. */
export function workflowAgent(agentId: string): AgentFixture | null {
  const automation = findAutomation(agentId.replace(/^workflow-/, ""));
  if (!automation) return null;
  const open = automation.runs.filter(isOpen);
  const done = automation.runs.filter((run) => !isOpen(run));
  const latest = latestRun(automation);
  const currentTurns: TurnFixture[] =
    open.length === 0 || !latest
      ? []
      : [
          {
            id: `${agentId}-open`,
            role: "assistant",
            at: timeFormatter.format(new Date(latest.startedAt)),
            blocks: [
              { kind: "text", text: openSummary(open) },
              linkBlock(automation),
              { kind: "delegation", delegationId: runDelegationId(latest.id) },
              openNotice(automation, open),
            ],
          },
        ];
  return {
    id: agentId,
    kind: "workflow",
    nodeId: workflowNodeId(automation.id),
    name: automation.agentName.replace(/ agent$/i, ""),
    scope: `runs ${automation.name}`,
    automationId: automation.id,
    current: {
      id: `${agentId}-current`,
      title: "Open runs",
      meta: `${open.length} open`,
      carriedOver: [],
      turns: currentTurns,
    },
    previous:
      done.length === 0
        ? []
        : [
            {
              id: `${agentId}-done`,
              title: "Earlier runs",
              meta: `${done.length} done`,
              carriedOver: [],
              turns: [
                {
                  id: `${agentId}-done-1`,
                  role: "assistant",
                  at: "Earlier",
                  blocks: [
                    {
                      kind: "text",
                      text: `${done.length} ${done.length === 1 ? "run" : "runs"} passed. Nothing needed you, so this chat closed.`,
                    },
                    linkBlock(automation),
                  ],
                },
              ],
            },
          ],
  };
}
