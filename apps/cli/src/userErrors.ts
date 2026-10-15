import * as Effect from "effect/Effect";
import { CliError } from "effect/cli";

/**
 * A command's failures as `effect/cli` shows them: one line with what went
 * wrong and what to do, no stack. Every error here carries such a message.
 */
export const asUserErrors = <A, E extends { readonly message: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.mapError(
    effect,
    (error) => new CliError.UserError({ cause: error, userMessage: error.message }),
  );
