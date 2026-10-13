/**
 * PLACEHOLDER trace entries for automation runs, built from the automation
 * fixtures (read-only): a run starts at the automation's trigger, not at the
 * assistant, so its trace is trigger → the run's thread. Automations have no
 * agents of their own; the agent of the level an automation lives in is
 * responsible for it (see `automations/automationHome.ts`). Only the trace
 * lookups in `assistantModel` read these.
 */
import { ProviderDriverKind } from "@t3tools/contracts";

import { AUTOMATIONS } from "../automations/automationFixtures";
import type {
  Automation,
  AutomationRun,
  AutomationRunStatus,
  AutomationRunTrigger,
} from "../automations/automationModel";
import type { DelegationFixture, DelegationStatus, TraceNodeFixture } from "./assistantFixtures";

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

const triggerNodeId = (automationId: string) => `trigger:${automationId}`;
const runNodeId = (runId: string) => `thread:run-${runId}`;
const runDelegationId = (runId: string) => `d-run-${runId}`;

const latestRun = (automation: Automation): AutomationRun | undefined => automation.runs[0];

export const WORKFLOW_NODES: readonly TraceNodeFixture[] = AUTOMATIONS.flatMap((automation) => {
  const run = latestRun(automation);
  if (!run) return [];
  return [
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
            to: runNodeId(run.id),
            at,
            status,
            message: `${TRIGGER_LABEL[run.trigger]} fired (${automation.cadence}). Run ${automation.name}.`,
          },
        ],
        statusDetail: automation.cadence,
      },
    ];
  },
);
