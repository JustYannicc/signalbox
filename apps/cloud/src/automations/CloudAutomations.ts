import type { AutomationError, OrchestrationV2DomainEvent } from "@t3tools/contracts";
import type { HostStepRequest, Marks, RunEnd } from "@signalbox/automations/runner/hostedDriver";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * A call from a run's Workflow instance, as its version's Dynamic Worker
 * makes it through `HOST` (`automationWorkflow.ts`). The entrypoint fixes
 * the automation and version the worker was loaded for; the object checks
 * the run belongs to them.
 */
export type AutomationHostCall = {
  readonly automationId: string;
  readonly version: number;
  readonly runId: string;
} & (
  | { readonly method: "step"; readonly request: HostStepRequest; readonly marks: Marks }
  | { readonly method: "settled"; readonly key: string }
  | { readonly method: "timedOut"; readonly key: string }
  | { readonly method: "failed"; readonly key: string; readonly error: string }
  | { readonly method: "finish"; readonly end: RunEnd; readonly marks: Marks }
);

/**
 * The user's automation engine (`@signalbox/automations`), as the user
 * object's entrypoints reach it. Each run is a Cloudflare Workflow instance;
 * the object records runs and steps and executes them. workerd ties promises
 * to the request that made them, so every entrypoint returns only once the
 * work it started here is done.
 */
export interface CloudAutomationsShape {
  /**
   * Domain events of one of the user's threads with their sequence, in order
   * and at least once. Events at or before a sequence already taken from that
   * thread are dropped, so a redelivered batch repeats nothing.
   */
  readonly threadEvents: (input: {
    readonly threadId: string;
    readonly events: ReadonlyArray<{
      readonly sequence: number;
      readonly event: OrchestrationV2DomainEvent;
    }>;
  }) => Effect.Effect<void, AutomationError>;
  /** An automation tool an agent calls from its thread's machine (`automation_save`, `wait_for`, …). */
  readonly tool: (
    caller: { readonly threadId: string },
    name: string,
    input: unknown,
  ) => Effect.Effect<unknown, AutomationError>;
  /** A run's instance calling back: starting a step, ending a wait, finishing. */
  readonly host: (call: AutomationHostCall) => Effect.Effect<unknown, AutomationError>;
  /** A version's code, for loading it as a Dynamic Worker. */
  readonly workerModule: (
    automationId: string,
    version: number,
  ) => Effect.Effect<string, AutomationError>;
  /** Starts due crons; the object's alarm calls it. */
  readonly wake: Effect.Effect<void, AutomationError>;
  /**
   * Waits for the work a request started here (an agent's turn, a thread
   * event's waits), pushes what it raised and sets the alarm for the next
   * cron. Every entrypoint above ends with it.
   */
  readonly flush: Effect.Effect<void, AutomationError>;
}

export class CloudAutomations extends Context.Service<CloudAutomations, CloudAutomationsShape>()(
  "@signalbox/cloud/automations/CloudAutomations",
) {}

/**
 * The object's alarm, as automations set it: `arm(at)` makes sure it fires by
 * `at` (epoch ms); null leaves it. The user object provides it from its storage.
 */
export class AutomationAlarm extends Context.Service<
  AutomationAlarm,
  { readonly arm: (at: number | null) => Effect.Effect<void> }
>()("@signalbox/cloud/automations/CloudAutomations/AutomationAlarm") {}
