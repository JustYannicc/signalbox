import type {
  AutomationError,
  AutomationSaveInput,
  AutomationSaveResult,
  ModelSelection,
  OrchestrationV2DomainEvent,
  ProjectId,
} from "@t3tools/contracts";
import type {
  AutomationRunHost,
  HostStepStart,
  Settlement,
} from "@signalbox/automations/workflow/hostProtocol";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { DriveRefEvent } from "../drive/DriveEvents.ts";
import type { HookAnswer, HookRequest } from "./webhookRequest.ts";

/** One `AutomationRunHost` method and its arguments, as a run's instance calls it. */
export type AutomationHostRequest = {
  [M in keyof AutomationRunHost]: {
    readonly method: M;
    readonly args: Parameters<AutomationRunHost[M]>;
  };
}[keyof AutomationRunHost];

/**
 * A call from a run's Workflow instance, as its version's Dynamic Worker
 * makes it through `HOST` (`automationWorkflow.ts`). The entrypoint fixes
 * the automation and version the worker was loaded for; the object checks
 * the run belongs to them.
 */
export type AutomationHostCall = AutomationHostRequest & {
  readonly automationId: string;
  readonly version: number;
};

/** An `AutomationRunHost` that sends each call through `send`: the Worker's `HOST`, and tests' double. */
export const hostOver = (
  send: (request: AutomationHostRequest) => Promise<unknown>,
): AutomationRunHost => ({
  step: (...args) => send({ method: "step", args }) as Promise<HostStepStart>,
  settled: async (...args) => {
    await send({ method: "settled", args });
  },
  timedOut: (...args) => send({ method: "timedOut", args }) as Promise<Settlement>,
  failed: async (...args) => {
    await send({ method: "failed", args });
  },
  finish: async (...args) => {
    await send({ method: "finish", args });
  },
});

/**
 * The user's automation engine (`@signalbox/automations`), as the user
 * object's entrypoints reach it. Each run is a Cloudflare Workflow instance;
 * the object records runs and steps and executes them. workerd ties promises
 * to the request that made them, so every entrypoint returns only once the
 * work it started here is done.
 */
export interface CloudAutomationsShape {
  /** Verifies and durably accepts a request before the Worker acknowledges it. */
  readonly receiveHook: (request: HookRequest) => Effect.Effect<HookAnswer, AutomationError>;
  readonly save: (
    input: Omit<AutomationSaveInput, "defaults"> & { readonly compiled?: unknown },
    newThreadModel: (projectId?: ProjectId) => Effect.Effect<ModelSelection | null>,
  ) => Effect.Effect<AutomationSaveResult, AutomationError>;
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
  /**
   * Ref moves of a drive the user is in (`drive/DriveEvents.ts`), in order
   * and at least once, as `drive.changed` and `drive.branch-saved` events in
   * the drive's project. Moves at or before a sequence already taken from
   * that drive are dropped.
   */
  readonly driveEvents: (input: {
    readonly driveId: string;
    readonly events: ReadonlyArray<DriveRefEvent>;
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
  /**
   * The object started: gives runs whose instance a cut-off request never
   * confirmed one, then flushes.
   */
  readonly start: Effect.Effect<void, AutomationError>;
  /** Starts due crons and tells instances outcomes they missed; the object's alarm calls it. */
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
