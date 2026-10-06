import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { MAX_WEBHOOK_DELIVERY_AGE_MINUTES } from "./scheduledTask.ts";

export * from "./automationEvents.ts";

/**
 * Automations are TypeScript workflow files. The server compiles each file into
 * `WorkflowMeta` plus a `WorkflowGraph`; nobody writes the graph by hand.
 *
 * The graph is a tree that mirrors the code's structure: a block is a list of
 * nodes that run top to bottom, and decisions, loops, parallel groups and
 * failure handlers hold their own blocks. Edges are implied by that structure.
 */

export const WorkflowCronTrigger = Schema.Struct({
  cron: TrimmedNonEmptyString.annotate({
    description: "Five-field cron expression, such as '0 9 * * 1'.",
  }),
  timezone: Schema.optional(TrimmedNonEmptyString).annotate({
    description: "IANA time zone for the cron expression. Defaults to the server's time zone.",
  }),
});
export type WorkflowCronTrigger = typeof WorkflowCronTrigger.Type;

/** HMAC-SHA256 over the raw body. The signing secret is set apart from the code and never shown. */
export const WorkflowWebhookSignature = Schema.Struct({
  header: TrimmedNonEmptyString.annotate({
    description: "Request header carrying the signature, such as x-hub-signature-256.",
  }),
  encoding: Schema.Literals(["hex", "base64"]).annotate({
    description: "How the HMAC-SHA256 digest is encoded in the header.",
  }),
  prefix: Schema.optional(Schema.String).annotate({
    description: "Text before the digest in the header value, such as 'sha256='.",
  }),
});
export type WorkflowWebhookSignature = typeof WorkflowWebhookSignature.Type;

export const WorkflowWebhookOptions = Schema.Struct({
  signature: Schema.optional(WorkflowWebhookSignature),
  maxDeliveryAgeMinutes: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_WEBHOOK_DELIVERY_AGE_MINUTES })),
  ).annotate({
    description:
      "Skip requests Signalbox Connect held longer than this while the server was offline.",
  }),
});
export type WorkflowWebhookOptions = typeof WorkflowWebhookOptions.Type;

export const WorkflowWebhookTrigger = Schema.Struct({
  webhook: Schema.Union([Schema.Literal(true), WorkflowWebhookOptions]).annotate({
    description:
      "Start a run for every request to the automation's webhook URL. An object checks a signature or skips stale held requests.",
  }),
});
export type WorkflowWebhookTrigger = typeof WorkflowWebhookTrigger.Type;

const EventFieldValue = Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]);

/**
 * Start a run for every matching event (see `automationEvents.ts`). The run's
 * input is the event's envelope. Threads that automations started never
 * trigger unless `includeAutomationThreads` is set, and an automation never
 * triggers on its own runs' events, so automations can't feed themselves.
 */
export const WorkflowEventTrigger = Schema.Struct({
  on: Schema.Union([TrimmedNonEmptyString, Schema.NonEmptyArray(TrimmedNonEmptyString)]).annotate({
    description:
      "Event names, or wildcards like 'turn.*' and '*'. Raw events are 'orchestration.<type>'.",
  }),
  scope: Schema.optional(Schema.Literals(["project", "all"])).annotate({
    description: "Only this automation's project (default), or every project.",
  }),
  from: Schema.optional(Schema.Literals(["people", "agents", "anyone"])).annotate({
    description: "Who has to have caused it, for events that say so. Defaults to people.",
  }),
  where: Schema.optional(
    Schema.Record(Schema.String, Schema.Union([EventFieldValue, Schema.Array(EventFieldValue)])),
  ).annotate({
    description: "Top-level event fields that must equal these values; an array means any of them.",
  }),
  includeAutomationThreads: Schema.optional(Schema.Boolean).annotate({
    description: "Also trigger on threads and turns automations started. Off by default.",
  }),
  maxRunsPerMinute: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
    description:
      "Pause this automation's event triggers when events start more runs than this in a minute. Defaults to 30.",
  }),
});
export type WorkflowEventTrigger = typeof WorkflowEventTrigger.Type;

/** Every automation can also be run by hand; that needs no trigger. */
export const WorkflowTrigger = Schema.Union([
  WorkflowCronTrigger,
  WorkflowWebhookTrigger,
  WorkflowEventTrigger,
]);
export type WorkflowTrigger = typeof WorkflowTrigger.Type;

const DurationAmount = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0));

/** A length of time as `{ minutes: 5 }`; units add up. Used by meta and step options. */
export const WorkflowDuration = Schema.Struct({
  seconds: Schema.optional(DurationAmount),
  minutes: Schema.optional(DurationAmount),
  hours: Schema.optional(DurationAmount),
  days: Schema.optional(DurationAmount),
});
export type WorkflowDuration = typeof WorkflowDuration.Type;

export const WorkflowMeta = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String),
  intent: Schema.optional(Schema.String).annotate({
    description: "What the user asked for when this automation was made, in their own words.",
  }),
  triggers: Schema.optional(Schema.Array(WorkflowTrigger)),
  timeout: Schema.optional(WorkflowDuration).annotate({
    description: "Fail a run that is still going after this long. No limit by default.",
  }),
  overlap: Schema.optional(Schema.Literals(["skip", "allow"])).annotate({
    description:
      "Whether a cron trigger starts a run while an earlier run is still going. Defaults to skip; event triggers only skip when this says so.",
  }),
});
export type WorkflowMeta = typeof WorkflowMeta.Type;

/** The durable steps an automation can take. Everything between them is plain code. */
export const WorkflowStepVerb = Schema.Literals([
  "agent",
  "call",
  "http",
  "run",
  "llm",
  "judge",
  "extract",
  "ask",
  "notify",
  "sleep",
  "waitFor",
  "recall",
  "remember",
  "start",
]);
export type WorkflowStepVerb = typeof WorkflowStepVerb.Type;

/** A label from the code. Template labels keep their static text; `…` marks the dynamic parts. */
export const WorkflowLabel = Schema.Struct({
  text: Schema.String,
  dynamic: Schema.Boolean,
});
export type WorkflowLabel = typeof WorkflowLabel.Type;

/** A step option as written: a literal value, or the source of the expression that computes it. */
export const WorkflowDetailValue = Schema.Union([
  Schema.Struct({ literal: Schema.Unknown }),
  Schema.Struct({ expression: Schema.String }),
]);
export type WorkflowDetailValue = typeof WorkflowDetailValue.Type;

export type WorkflowNode =
  | WorkflowStepNode
  | WorkflowBranchNode
  | WorkflowLoopNode
  | WorkflowParallelNode
  | WorkflowTryNode
  | WorkflowEndNode;

export interface WorkflowArm {
  readonly label: string;
  readonly body: ReadonlyArray<WorkflowNode>;
}

/**
 * One durable step. `service` names what the step talks to, for its logo:
 * the connected integration for `call` (`stripe`), the host for `http`
 * (`api.github.com`), the provider for `agent` (`claudeAgent`) when the code
 * names one. `outcomes` lists the answers a `judge` or `ask` can give.
 */
export interface WorkflowStepNode {
  readonly type: "step";
  readonly id: string;
  readonly line: number;
  readonly verb: WorkflowStepVerb;
  readonly label: WorkflowLabel;
  readonly service?: string | undefined;
  readonly detail: { readonly [key: string]: WorkflowDetailValue };
  readonly outcomes?: ReadonlyArray<string> | undefined;
}

/**
 * A decision with one arm per option, in code order. `condition` decisions
 * come from `if`/`else if`/`else`, `switch`, `?:` and `&&`/`||`; `outcome`
 * decisions branch on the answer of the `judge` or `ask` step `decidedBy`.
 */
export interface WorkflowBranchNode {
  readonly type: "branch";
  readonly id: string;
  readonly line: number;
  readonly source: "condition" | "outcome";
  readonly label: WorkflowLabel;
  readonly decidedBy?: string | undefined;
  readonly arms: ReadonlyArray<WorkflowArm>;
}

/**
 * `each` runs its body per item and `repeat` until `done` or `max` attempts;
 * `for` and `while` are plain loops in the code.
 */
export interface WorkflowLoopNode {
  readonly type: "loop";
  readonly id: string;
  readonly line: number;
  readonly verb: "each" | "repeat" | "for" | "while";
  readonly label: WorkflowLabel;
  readonly max?: number | undefined;
  readonly concurrency?: number | undefined;
  readonly body: ReadonlyArray<WorkflowNode>;
}

export interface WorkflowParallelNode {
  readonly type: "parallel";
  readonly id: string;
  readonly line: number;
  readonly label: WorkflowLabel;
  readonly branches: ReadonlyArray<WorkflowArm>;
}

/** `try`/`catch` around steps: `failure` runs when something in `body` fails. */
export interface WorkflowTryNode {
  readonly type: "try";
  readonly id: string;
  readonly line: number;
  readonly label: WorkflowLabel;
  readonly body: ReadonlyArray<WorkflowNode>;
  readonly failure: ReadonlyArray<WorkflowNode>;
}

/**
 * An early `return`. `workflow` ends the run, `callback` ends this item,
 * attempt or parallel branch (`done` when a repeat stops), and `helper`
 * returns from a helper function.
 */
export interface WorkflowEndNode {
  readonly type: "end";
  readonly id: string;
  readonly line: number;
  readonly exit: "workflow" | "callback" | "helper";
  readonly done?: boolean | undefined;
  /** `return w.restart(input)`: the run ends and a fresh run of the automation starts. */
  readonly restart?: boolean | undefined;
}

const NodeRef = Schema.suspend((): Schema.Codec<WorkflowNode> => WorkflowNodeSchema);
const Nodes = Schema.Array(NodeRef);
const Line = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const Arm = Schema.Struct({ label: Schema.String, body: Nodes });

export const WorkflowNodeSchema: Schema.Codec<WorkflowNode> = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("step"),
    id: Schema.String,
    line: Line,
    verb: WorkflowStepVerb,
    label: WorkflowLabel,
    service: Schema.optional(Schema.String),
    detail: Schema.Record(Schema.String, WorkflowDetailValue),
    outcomes: Schema.optional(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    type: Schema.Literal("branch"),
    id: Schema.String,
    line: Line,
    source: Schema.Literals(["condition", "outcome"]),
    label: WorkflowLabel,
    decidedBy: Schema.optional(Schema.String),
    arms: Schema.Array(Arm),
  }),
  Schema.Struct({
    type: Schema.Literal("loop"),
    id: Schema.String,
    line: Line,
    verb: Schema.Literals(["each", "repeat", "for", "while"]),
    label: WorkflowLabel,
    max: Schema.optional(Schema.Int),
    concurrency: Schema.optional(Schema.Int),
    body: Nodes,
  }),
  Schema.Struct({
    type: Schema.Literal("parallel"),
    id: Schema.String,
    line: Line,
    label: WorkflowLabel,
    branches: Schema.Array(Arm),
  }),
  Schema.Struct({
    type: Schema.Literal("try"),
    id: Schema.String,
    line: Line,
    label: WorkflowLabel,
    body: Nodes,
    failure: Nodes,
  }),
  Schema.Struct({
    type: Schema.Literal("end"),
    id: Schema.String,
    line: Line,
    exit: Schema.Literals(["workflow", "callback", "helper"]),
    done: Schema.optional(Schema.Boolean),
    restart: Schema.optional(Schema.Boolean),
  }),
]);

export const WorkflowGraph = Schema.Struct({ nodes: Nodes });
export type WorkflowGraph = typeof WorkflowGraph.Type;

/** A compile error, pointing at the code the author has to change. */
export const WorkflowDiagnostic = Schema.Struct({
  message: Schema.String,
  line: Line,
  column: Line,
  hint: Schema.optional(Schema.String),
});
export type WorkflowDiagnostic = typeof WorkflowDiagnostic.Type;

/**
 * Maps a runtime step key to its graph node id. Runtime keys count repeated
 * calls of the same site (`s7#2`) and add the iteration of `each`/`repeat`
 * frames (`s4[2]/s7`); the graph has one node for all of them.
 */
export function workflowNodeIdForStepKey(stepKey: string): string {
  return stepKey.replace(/\[\d+\]|#\d+/g, "");
}

/** One `each`/`repeat` pass a step key sits in: `s2/s4#2[3]/s7` has `{ loopKey: "s2/s4#2", pass: 3 }`. */
export interface WorkflowStepKeyFrame {
  /** The loop call's key, without the pass. A loop reached twice has two keys. */
  readonly loopKey: string;
  /** Zero-based. */
  readonly pass: number;
}

/** The loop passes a step key sits in, outermost first. */
export function workflowStepKeyFrames(stepKey: string): WorkflowStepKeyFrame[] {
  return [...stepKey.matchAll(/\[(\d+)\]/g)].map((match) => ({
    loopKey: stepKey.slice(0, match.index),
    pass: Number(match[1]),
  }));
}

/** Which call of a repeated call site a step key is: `s7#2` is 2, a first call null. */
export function workflowStepKeyCall(stepKey: string): number | null {
  const call = /#(\d+)$/.exec(stepKey)?.[1];
  return call === undefined ? null : Number(call);
}
