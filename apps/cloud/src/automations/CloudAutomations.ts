import type { AutomationError, OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * The user's automation engine (`@signalbox/automations`), as the user
 * object's entrypoints reach it. workerd ties promises to the request that
 * made them, so every entrypoint returns only once the runs it touched have
 * parked: nothing keeps working after the request ends.
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
  /** Runs due work (timers, crons, retries); returns when the object should wake next, in epoch ms. */
  readonly wake: Effect.Effect<number | null, AutomationError>;
}

export class CloudAutomations extends Context.Service<CloudAutomations, CloudAutomationsShape>()(
  "@signalbox/cloud/automations/CloudAutomations",
) {}
