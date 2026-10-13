/**
 * Approve / reject for a step that waits on you: an approval step with a
 * prepared draft, or an inline hook that held a message. A held message links
 * to the thread it was held in. Same controls in the run chat and the canvas
 * details panel.
 */
import { Link } from "@tanstack/react-router";

import { Button } from "../ui/button";
import type { NodeRunResult, WorkflowNode } from "./automationModel";
import { useRunDecisionStore } from "./runDecisions";

function field(input: unknown, key: string) {
  if (input && typeof input === "object" && key in input) {
    const value = (input as Record<string, unknown>)[key];
    return typeof value === "string" ? value : null;
  }
  return null;
}

/** Whether this step is waiting on you and gets approve/reject controls. */
export function awaitsDecision(node: WorkflowNode, result: NodeRunResult | null | undefined) {
  if (result?.status !== "waiting") return false;
  return (
    node.config.kind === "approval" ||
    (node.config.kind === "verdict" && node.config.action === "hold")
  );
}

export function RunApprovalActions(props: {
  runId: string;
  node: WorkflowNode;
  result: NodeRunResult;
}) {
  const decide = useRunDecisionStore((state) => state.decide);
  const draft = field(props.result.input, "draft");
  const held = field(props.result.input, "heldMessage");
  const threadId = field(props.result.input, "threadId");
  const threadTitle = field(props.result.input, "threadTitle");
  const isApproval = props.node.config.kind === "approval";

  return (
    <div className="flex flex-col gap-2.5">
      {(draft ?? held) ? (
        <p className="rounded-md border bg-background px-2.5 py-2 text-sm leading-relaxed">
          {draft ?? held}
        </p>
      ) : null}
      {threadId ? (
        <Link
          to="/shared/$threadId"
          params={{ threadId }}
          className="self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          Held in {threadTitle ?? "its thread"}
        </Link>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button size="xs" onClick={() => decide(props.runId, "approved")}>
          {isApproval ? "Approve and send" : "Let it through"}
        </Button>
        {isApproval ? (
          <Button size="xs" variant="outline" onClick={() => decide(props.runId, "edited")}>
            Edit first
          </Button>
        ) : null}
        <Button size="xs" variant="ghost" onClick={() => decide(props.runId, "rejected")}>
          Reject
        </Button>
      </div>
    </div>
  );
}
