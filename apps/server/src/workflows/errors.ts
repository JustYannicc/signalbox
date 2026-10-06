import { AutomationError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Small error helpers every automation module shares. */

export const isAutomationError = Schema.is(AutomationError);

interface ErrorContext {
  readonly automationId?: string | undefined;
  readonly runId?: string | undefined;
  readonly cause?: unknown;
}

/** An AutomationError with the ids and cause it has; absent ones stay off the error. */
export const automationError = (message: string, context: ErrorContext = {}) =>
  new AutomationError({
    message,
    ...(context.automationId === undefined ? {} : { automationId: context.automationId }),
    ...(context.runId === undefined ? {} : { runId: context.runId }),
    ...(context.cause === undefined ? {} : { cause: context.cause }),
  });

export const fail = (message: string, context?: ErrorContext) =>
  Effect.fail(automationError(message, context));

/** What a thrown value says about itself: its `message`, else the value as text. */
export const errorMessage = (cause: unknown) =>
  String((cause as { message?: unknown } | null)?.message ?? cause);

/** The text of a cause's main failure. */
export const causeText = (cause: Cause.Cause<unknown>) => errorMessage(Cause.squash(cause));

/** Logs a failure and carries on; an interruption stays an interruption. */
export const logFailure =
  (what: string, annotations: Readonly<Record<string, unknown>> = {}) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | void, never, R> =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning(what, { ...annotations, cause }),
      ),
    );
