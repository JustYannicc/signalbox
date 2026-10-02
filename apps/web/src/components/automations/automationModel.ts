/**
 * Shapes and display helpers for the Automations prototype. The types mirror
 * what the UI needs to render, not a server contract; they move into
 * `packages/contracts` once automations exist.
 */

export type AutomationRunStatus = "success" | "failed" | "running" | "waiting";
export type NodeRunStatus = AutomationRunStatus | "skipped";
export type AutomationRunTrigger = "schedule" | "webhook" | "event" | "hook" | "device" | "manual";
/** `assistant` is a named agent like Appa rather than a coding harness. */
export type AgentProvider = "codex" | "claudeAgent" | "assistant";

/** Whose side of a boundary a step runs on, e.g. the company's agent vs. yours. */
export interface NodeOwner {
  scope: "company" | "personal";
  label: string;
}

/** One way out of a branching node; `key` is what edges and run outputs use. */
export interface NodeOutput {
  key: string;
  label: string;
}

export interface ApprovalCorrection {
  at: string;
  subject: string;
  note: string;
}

export type WorkflowNodeConfig =
  | { kind: "trigger"; source: "schedule"; cron: string; timezone: string; summary: string }
  | { kind: "trigger"; source: "webhook"; method: "POST"; path: string; event: string }
  | {
      kind: "trigger";
      source: "event";
      integration: string;
      event: string;
      filter?: Record<string, unknown>;
    }
  /**
   * A hook inside Signalbox's own flows. Inline hooks run before the thing
   * happens and can allow, modify, hold, or block it within `budget`.
   */
  | {
      kind: "trigger";
      source: "hook";
      hook: string;
      mode: "inline" | "async";
      scope: string;
      budget?: string;
    }
  /** A signal a client device reports. Clients never run steps; the server does. */
  | {
      kind: "clientSignal";
      device: string;
      deviceKind: "laptop" | "phone";
      signal: "wifi" | "nfc" | "time" | "location";
      condition: string;
    }
  | {
      kind: "agent";
      provider: AgentProvider;
      providerLabel: string;
      model: string;
      project: string;
      prompt: string;
      /** Where the agent's work shows up, e.g. "New Task". */
      opens?: string;
      /** The agent only gets messages; it never learns a workflow is driving it. */
      unawareOfWorkflow?: boolean;
    }
  | {
      kind: "tool";
      integration: string;
      action: string;
      params: Record<string, unknown>;
      /** Defaults to Executor. */
      via?: string;
    }
  /** A code step: plain TypeScript in the workflow source; `fn` names the function. */
  | { kind: "step"; fn: string; summary: string; params?: Record<string, unknown> }
  | { kind: "condition"; expression: string; trueLabel: string; falseLabel: string }
  /**
   * Loop control: the first output retries along a loop edge back to an
   * earlier step, at most `maxIterations` times; the second gives up.
   */
  | { kind: "gate"; maxIterations: number; retryLabel: string; exitLabel: string }
  /** A model decision (any model, Jev included) whose named outcome picks the branch. */
  | {
      kind: "judge";
      model: string;
      question: string;
      outcomes: readonly NodeOutput[];
      /** False when the outcome only labels the item and every outcome continues the same way. */
      branches?: boolean;
      latency?: string;
    }
  /** What an inline hook does with the intercepted request. Ends the workflow. */
  | { kind: "verdict"; action: "allow" | "hold" | "block" | "modify"; effect: string }
  | { kind: "computer"; image: string; task: string; lifetime: string }
  | {
      kind: "handoff";
      from: string;
      to: string;
      request: string;
      shares: readonly string[];
      withheld: readonly string[];
      scopeNote: string;
    }
  | {
      kind: "approval";
      approver: string;
      where: string;
      prepares: string;
      corrections: readonly ApprovalCorrection[];
    }
  /**
   * Tells the user something. The notification router decides where it lands
   * (laptop badge, phone push, or quiet) from importance and presence; posting
   * to Slack or email is a tool step instead.
   */
  | { kind: "notify"; message: string; importance: "low" | "normal" | "urgent" };

export type WorkflowNodeKind = WorkflowNodeConfig["kind"];

export interface WorkflowNode {
  id: string;
  title: string;
  /** Canvas coordinates of the card's top-left corner. */
  x: number;
  y: number;
  config: WorkflowNodeConfig;
  owner?: NodeOwner;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  /** Set on edges leaving a branching node; matches a `NodeOutput` key. */
  branch?: string;
  /** Goes back to an earlier step, drawn under the graph. */
  loop?: boolean;
  /** Only carries traffic when a loop retries (a failing judge, the loop itself). */
  retry?: boolean;
  /** Shown at the middle of the edge, e.g. what crosses an ownership boundary. */
  label?: string;
  boundary?: boolean;
}

/** A horizontal band grouping the nodes one owner runs. */
export interface WorkflowLane {
  owner: NodeOwner;
  y: number;
  height: number;
}

export interface NodeRunResult {
  status: NodeRunStatus;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
}

/** One pass through a review loop. */
export interface RunIteration {
  status: "success" | "failed" | "running";
  findings: number;
  summary: string;
  durationMs?: number;
}

export interface AutomationRun {
  id: string;
  /** Title of the chat the run produced. */
  title: string;
  status: AutomationRunStatus;
  trigger: AutomationRunTrigger;
  startedAt: string;
  /** Null while the run is still going or waiting on someone. */
  durationMs: number | null;
  nodes: Record<string, NodeRunResult>;
  /** Review loops only, oldest first. */
  iterations?: readonly RunIteration[];
}

export interface Automation {
  id: string;
  name: string;
  description: string;
  /** The unnamed supervisor agent responsible for this workflow, e.g. "Sentry fixer agent". */
  agentName: string;
  /** The root section it belongs to, so Focus can hide it. System automations have none. */
  section?: "work" | "personal";
  /** Inline hooks: passes don't become runs, they only count. */
  allowedToday?: number;
  /** Human cadence, e.g. "Daily at 3:00 AM". */
  cadence: string;
  enabled: boolean;
  /** Null for paused and event-driven automations. */
  nextRunAt: string | null;
  /** Built-in automations can be edited but not removed. */
  system?: { reason: string };
  /** The TypeScript workflow file. It is authoritative; the graph is derived from it. */
  source: { path: string; code: string };
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  lanes?: readonly WorkflowLane[];
  /** Newest first. */
  runs: readonly AutomationRun[];
}

export function isTriggerNode(config: WorkflowNodeConfig) {
  return config.kind === "trigger" || config.kind === "clientSignal";
}

/** The named outputs of a branching node, top to bottom; null for single-output nodes. */
export function nodeOutputs(config: WorkflowNodeConfig): readonly NodeOutput[] | null {
  switch (config.kind) {
    case "condition":
      return [
        { key: "true", label: config.trueLabel },
        { key: "false", label: config.falseLabel },
      ];
    case "gate":
      return [
        { key: "true", label: config.retryLabel },
        { key: "false", label: config.exitLabel },
      ];
    case "judge":
      return config.branches === false ? null : config.outcomes;
    default:
      return null;
  }
}

/** Vertical position of an output handle as a fraction of the card height. */
export function outputFraction(config: WorkflowNodeConfig, branch: string | undefined) {
  const outputs = nodeOutputs(config);
  const index = outputs && branch ? outputs.findIndex((output) => output.key === branch) : -1;
  return outputs && index >= 0 ? (index + 1) / (outputs.length + 1) : 1 / 2;
}

/** The review-loop cap from the workflow's gate, or null when it has none. */
export function maxIterations(nodes: readonly WorkflowNode[]) {
  for (const node of nodes) {
    if (node.config.kind === "gate") return node.config.maxIterations;
  }
  return null;
}

export function workflowAgentId(automation: Automation) {
  return `workflow-${automation.id}`;
}

/** Card geometry shared by the canvas, edges, and fit-to-view math. */
export const NODE_WIDTH = 232;
export const NODE_HEIGHT = 68;
