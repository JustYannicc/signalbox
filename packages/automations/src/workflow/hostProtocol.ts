import type { WorkflowStepVerb } from "@t3tools/contracts";

/** A step the automation reached. */
export interface StepRequest {
  readonly key: string;
  readonly verb: WorkflowStepVerb;
  readonly label: string;
  readonly args: ReadonlyArray<unknown>;
}

/**
 * What an automation version's Dynamic Worker (`runtime.ts`) asks of the
 * Worker that hosts it, through its one binding, `HOST`. `step`, `timedOut`
 * and `finish` run inside `step.do`, so Cloudflare journals the answer and a
 * replay doesn't ask again (a retry may, though). `settled` and `failed` are
 * plain calls that repeat on replays. The host makes all of them idempotent
 * per `(runId, key)`.
 */
export interface AutomationRunHost {
  /**
   * Starts the step at `request.key`. Throw to make Cloudflare retry it
   * (transient failures); answer `failed` for a failure the automation sees.
   * `marks` are the branch decisions and loop counts the code recorded since
   * the last host call. A retry or replay can send one again: upsert by key.
   */
  step(runId: string, request: StepRequest, marks: Marks): Promise<HostStepStart>;
  /** A `sleep` start's time came. `value` is always null today. Not journaled: repeats on every replay, and a throw is dropped. */
  settled(runId: string, key: string, value: null): Promise<void>;
  /**
   * A `waiting` start's event didn't arrive in time. Called inside its own
   * `step.do`, so the answer is journaled: the step's late result, or its
   * timeout as an error.
   */
  timedOut(runId: string, key: string): Promise<Settlement>;
  /**
   * `step` kept throwing until Cloudflare gave up, or a wait broke for a reason
   * other than its timeout; the automation sees `error`. Not journaled, and a
   * throw is dropped.
   */
  failed(runId: string, key: string, error: string): Promise<void>;
  /**
   * The workflow returned or threw. Journaled as the `~finish` step, so it
   * repeats only while Cloudflare retries it. `end` is JSON-normalized.
   */
  finish(runId: string, end: RunEnd, marks: Marks): Promise<void>;
}

/** What the dispatcher's `WorkflowEntrypoint` puts in `event.payload`. */
export interface AutomationRunPayload {
  readonly runId: string;
  readonly input: unknown;
  readonly trigger: unknown;
}

/** `[key, value]` pairs from `w.when`, `$arm`, `each` and `repeat`. */
export type Marks = ReadonlyArray<readonly [key: string, value: unknown]>;

/** How a step starts. */
export type HostStepStart =
  /** Finished right away (or already had): the call resolves with `value`. */
  | { readonly type: "done"; readonly value: unknown }
  /** The call rejects with an Error whose message is `error`; `detail` rides on it. */
  | { readonly type: "failed"; readonly error: string; readonly detail?: unknown }
  /** Resumes at `until` (epoch ms); the runtime then calls `settled` and resolves null. */
  | { readonly type: "sleep"; readonly until: number }
  /**
   * Waits for a Workflow event of type `event` (`^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`,
   * at most 100 chars) whose payload is a `Settlement`. Null waits as long as
   * Cloudflare allows (365 days).
   */
  | { readonly type: "waiting"; readonly event: string; readonly timeoutMs: number | null };

/** A waiting step's result: the payload the host sends with `instance.sendEvent`. */
export type Settlement =
  | { readonly ok: true; readonly value: unknown }
  /** Rejects the call with an Error whose message is `error`; `detail` (why, how to fix) rides on it. */
  | { readonly ok: false; readonly error: string; readonly detail?: unknown };

/** How a run ended. */
export type RunEnd =
  | { readonly type: "completed"; readonly output: unknown }
  /** The code returned `w.restart(input)`: the host starts a fresh run with `input`. */
  | { readonly type: "restart"; readonly input: unknown }
  | { readonly type: "failed"; readonly error: string };
