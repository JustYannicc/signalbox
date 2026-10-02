/**
 * PLACEHOLDER: approve/edit/reject on a waiting run, kept in memory only.
 * A decided run stops waiting everywhere it shows (sidebar, digest, run chat,
 * canvas) because every surface reads automations through `useAutomations()`.
 */
import { useMemo } from "react";
import { create } from "zustand";

import { AUTOMATIONS } from "./automationFixtures";
import type { Automation, AutomationRun, NodeRunResult } from "./automationModel";
import { automationAttention } from "./automationStatus";

export type RunDecision = "approved" | "edited" | "rejected";

interface RunDecisionState {
  decisions: Readonly<Record<string, RunDecision>>;
  decide: (runId: string, decision: RunDecision) => void;
}

export const useRunDecisionStore = create<RunDecisionState>()((set) => ({
  decisions: {},
  decide: (runId, decision) =>
    set((state) => ({ decisions: { ...state.decisions, [runId]: decision } })),
}));

const DECISION_PREFIX: Record<RunDecision, string> = {
  approved: "Approved",
  edited: "Sent after edits",
  rejected: "Rejected",
};

function decidedRun(run: AutomationRun, decision: RunDecision): AutomationRun {
  if (run.status !== "waiting") return run;
  const nodes: Record<string, NodeRunResult> = {};
  for (const [id, result] of Object.entries(run.nodes)) {
    nodes[id] =
      result.status === "waiting"
        ? { ...result, status: "success", output: { decision: DECISION_PREFIX[decision] } }
        : result;
  }
  const title = run.title.replace(/^[^:]+: /, "");
  return { ...run, status: "success", title: `${DECISION_PREFIX[decision]}: ${title}`, nodes };
}

export function applyRunDecisions(
  automations: readonly Automation[],
  decisions: Readonly<Record<string, RunDecision>>,
): readonly Automation[] {
  if (Object.keys(decisions).length === 0) return automations;
  return automations.map((automation) =>
    automation.runs.some((run) => decisions[run.id])
      ? {
          ...automation,
          runs: automation.runs.map((run) => {
            const decision = decisions[run.id];
            return decision ? decidedRun(run, decision) : run;
          }),
        }
      : automation,
  );
}

/** Every automation with local run decisions applied. */
export function useAutomations(): readonly Automation[] {
  const decisions = useRunDecisionStore((state) => state.decisions);
  return useMemo(() => applyRunDecisions(AUTOMATIONS, decisions), [decisions]);
}

export function useAutomation(automationId: string): Automation | null {
  const automations = useAutomations();
  return automations.find((automation) => automation.id === automationId) ?? null;
}

/** The "needs you" feed with local decisions applied; for Pipeline, Home, and the rail. */
export function useAutomationAttention() {
  const automations = useAutomations();
  return useMemo(() => automationAttention(automations), [automations]);
}
