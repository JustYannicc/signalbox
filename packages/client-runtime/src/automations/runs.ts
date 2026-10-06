import {
  workflowNodeIdForStepKey,
  workflowStepKeyFrames,
  type AutomationRunSummary,
  type AutomationStep,
  type AutomationStepStatus,
  type WorkflowNode,
} from "@t3tools/contracts";
import { ellipsize } from "@t3tools/shared/String";

import { RUN_TRIGGER_LABEL } from "./labels.ts";
import { morePressingStatus } from "./status.ts";

/**
 * How a run reads in lists and as a chat: its title, a one-line readout of a
 * step's result, and its steps in the order they ran with loop passes grouped.
 * Shared by web and mobile so a run reads the same everywhere.
 */

/** The blocks nested inside a node: branch arms, parallel branches, a loop body, try and catch. */
export function childNodes(node: WorkflowNode): ReadonlyArray<WorkflowNode> {
  switch (node.type) {
    case "branch":
      return node.arms.flatMap((arm) => arm.body);
    case "parallel":
      return node.branches.flatMap((arm) => arm.body);
    case "loop":
      return node.body;
    case "try":
      return [...node.body, ...node.failure];
    default:
      return [];
  }
}

export function findWorkflowNode(
  nodes: ReadonlyArray<WorkflowNode>,
  id: string,
): WorkflowNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findWorkflowNode(childNodes(node), id);
    if (found) return found;
  }
  return null;
}

/** Every step of one diagram node in a run (loops run a node many times), newest first. */
export function stepsForNode(
  steps: ReadonlyArray<AutomationStep>,
  nodeId: string,
): AutomationStep[] {
  const ordered = stepsInRunOrder(steps);
  const newestFirst: AutomationStep[] = [];
  for (let index = ordered.length - 1; index >= 0; index--) {
    const step = ordered[index]!;
    if (workflowNodeIdForStepKey(step.key) === nodeId) newestFirst.push(step);
  }
  return newestFirst;
}

function firstLine(text: string, maxLength = 120): string {
  const line =
    text
      .trim()
      .split("\n")
      .find((candidate) => candidate.trim())
      ?.trim() ?? "";
  return ellipsize(line, maxLength);
}

/** What the run said it did, else its state in words: "Waiting on you", "Running", the error. */
export function runTitle(
  run: Pick<AutomationRunSummary, "title" | "status" | "waitingOnYou" | "error" | "trigger">,
): string {
  const title = run.title ? firstLine(run.title) : "";
  if (title) return title;
  if (run.waitingOnYou) return "Waiting on you";
  switch (run.status) {
    case "running":
      return "Running";
    case "failed":
      return (run.error && firstLine(run.error)) || "Failed";
    case "cancelled":
      return "Cancelled";
    case "succeeded":
      return RUN_TRIGGER_LABEL[run.trigger];
  }
}

const HIDDEN_RESULT_KEYS = new Set(["threadId"]);

/** A step's result in one line: text as its first line, objects as "key: value · key: value". */
export function resultLine(result: unknown, maxLength = 200): string | null {
  if (result === null || result === undefined) return null;
  let text: string;
  if (typeof result === "string") {
    text = firstLine(result, maxLength);
  } else if (typeof result !== "object") {
    text = String(result);
  } else if (Array.isArray(result)) {
    text = result.length === 1 ? "1 item" : `${result.length} items`;
  } else {
    text = Object.entries(result)
      .filter(([key, value]) => !HIDDEN_RESULT_KEYS.has(key) && value !== undefined)
      .map(([key, value]) => {
        const shown =
          typeof value === "string"
            ? firstLine(value, 60)
            : typeof value === "object" && value !== null
              ? Array.isArray(value)
                ? `${value.length} items`
                : "{…}"
              : String(value);
        return `${key}: ${shown}`;
      })
      .join(" · ");
  }
  return text ? ellipsize(text, maxLength) : null;
}

export interface RunPass {
  /** Zero-based pass of the loop. */
  readonly index: number;
  readonly steps: ReadonlyArray<AutomationStep>;
}

export type RunChatItem =
  | { readonly kind: "step"; readonly step: AutomationStep }
  | {
      readonly kind: "loop";
      /** The loop call's key; a loop reached twice is two groups. */
      readonly key: string;
      readonly nodeId: string;
      readonly passes: ReadonlyArray<RunPass>;
    };

/** Steps in the order they started; ties keep the server's order. */
export function stepsInRunOrder(steps: ReadonlyArray<AutomationStep>): AutomationStep[] {
  return steps
    .map((step, position) => ({ step, position }))
    .sort(
      (left, right) =>
        left.step.startedAt.localeCompare(right.step.startedAt) || left.position - right.position,
    )
    .map((entry) => entry.step);
}

function groupPasses(
  steps: ReadonlyArray<AutomationStep>,
  passOf: (step: AutomationStep) => number,
) {
  const passes = new Map<number, AutomationStep[]>();
  for (const step of steps) {
    const index = passOf(step);
    const list = passes.get(index);
    if (list) list.push(step);
    else passes.set(index, [step]);
  }
  return [...passes.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, passSteps]): RunPass => ({ index, steps: passSteps }));
}

/**
 * A run as a chat: one item per step in execution order, except that the
 * steps of an `each` or `repeat` gather into one item where the loop first
 * ran, split into its passes. Loops nested inside a pass stay flat within it.
 */
export function runChatItems(steps: ReadonlyArray<AutomationStep>): RunChatItem[] {
  const items: Array<RunChatItem | { kind: "loopSlot"; key: string }> = [];
  const loops = new Map<string, AutomationStep[]>();
  for (const step of stepsInRunOrder(steps)) {
    const outer = workflowStepKeyFrames(step.key)[0];
    if (!outer) {
      items.push({ kind: "step", step });
      continue;
    }
    const existing = loops.get(outer.loopKey);
    if (existing) {
      existing.push(step);
    } else {
      loops.set(outer.loopKey, [step]);
      items.push({ kind: "loopSlot", key: outer.loopKey });
    }
  }
  return items.map((item): RunChatItem => {
    if (item.kind !== "loopSlot") return item;
    const loopSteps = loops.get(item.key) ?? [];
    return {
      kind: "loop",
      key: item.key,
      nodeId: workflowNodeIdForStepKey(item.key),
      passes: groupPasses(loopSteps, (step) => workflowStepKeyFrames(step.key)[0]?.pass ?? 0),
    };
  });
}

/**
 * Every pass of the loop node `loopId` in a run, in order. A loop nested in
 * another runs once per outer pass; those calls are merged by pass number.
 */
export function loopPasses(steps: ReadonlyArray<AutomationStep>, loopId: string): RunPass[] {
  const passOf = new Map<AutomationStep, number>();
  for (const step of stepsInRunOrder(steps)) {
    const frame = workflowStepKeyFrames(step.key).find(
      (candidate) => workflowNodeIdForStepKey(candidate.loopKey) === loopId,
    );
    if (frame) passOf.set(step, frame.pass);
  }
  return groupPasses([...passOf.keys()], (step) => passOf.get(step) ?? 0);
}

/** How a pass went: its most pressing step, how long it took, and what it ended with. */
export function passSummary(pass: RunPass): {
  readonly status: AutomationStepStatus;
  readonly durationMs: number | null;
  readonly line: string | null;
  /** The step whose status the pass shows. */
  readonly step: AutomationStep;
} {
  // A pass always has a step: passes are made by grouping steps.
  let step = pass.steps[0]!;
  for (const candidate of pass.steps)
    if (morePressingStatus(step.status, candidate.status) !== step.status) step = candidate;
  const finished = pass.steps.every((candidate) => candidate.finishedAt !== null);
  const start = Math.min(...pass.steps.map((candidate) => Date.parse(candidate.startedAt)));
  const end = Math.max(...pass.steps.map((candidate) => Date.parse(candidate.finishedAt ?? "")));
  const last = pass.steps.at(-1);
  return {
    status: step.status,
    durationMs: finished && Number.isFinite(end - start) ? end - start : null,
    line: step.error ?? (last ? resultLine(last.result) : null),
    step,
  };
}
