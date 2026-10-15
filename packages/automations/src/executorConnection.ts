import type { AutomationError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

/** Where `w.call` sends calls, and the key it sends them with. */
export interface ExecutorSettings {
  readonly url: string;
  readonly apiKey: string;
  /** "environment" when SIGNALBOX_EXECUTOR_URL / SIGNALBOX_EXECUTOR_API_KEY set it. */
  readonly source: "settings" | "environment";
}

/**
 * Reads and writes the Executor connection `w.call` uses. Each host keeps it
 * its own way (the server's is executorSettings.ts); without one, calls say
 * Executor isn't connected.
 */
export class ExecutorSettingsStore extends Context.Service<
  ExecutorSettingsStore,
  {
    readonly read: Effect.Effect<Option.Option<ExecutorSettings>, AutomationError>;
    readonly write: (input: {
      readonly url: string;
      readonly apiKey: string;
    }) => Effect.Effect<void, AutomationError>;
    readonly clear: Effect.Effect<void, AutomationError>;
  }
>()("@signalbox/automations/executorConnection/ExecutorSettingsStore") {}
