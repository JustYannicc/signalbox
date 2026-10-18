import type { AutomationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { fail } from "./errors.ts";
import { extractionOutput } from "./modelOutput.ts";
import { modelPrompt, modelResult, type ModelVerb } from "./modelSteps.ts";
import { retryDelayMs, retryPolicy, stepTimeoutMs, transientCause } from "./stepPolicy.ts";

/** Owns model and output attempts within one host call; recovery can restart that budget. */
export const runModelStep = <R>(input: {
  readonly verb: ModelVerb;
  readonly label: string;
  readonly options: Readonly<Record<string, unknown>>;
  readonly complete: (prompt: string) => Effect.Effect<string, AutomationError, R>;
}) => {
  const { verb, options } = input;
  return Effect.gen(function* () {
    const output =
      verb === "extract"
        ? extractionOutput(options.schema)
        : { ok: true as const, decode: (text: string) => modelResult(verb, options, text) };
    if (!output.ok) return yield* fail(output.error);
    const prompt = modelPrompt(verb, input.label, options);
    const policy = retryPolicy(verb, [options]);
    for (let attempt = 1; ; attempt++) {
      const answer = yield* Effect.result(input.complete(prompt));
      if (Result.isFailure(answer)) {
        const transient = transientCause(answer.failure);
        if (transient === undefined) return yield* Effect.fail(answer.failure);
        // Exhaustion is final: don't hand a retry marker to the hosted transport.
        if (attempt >= policy.attempts)
          return yield* fail(answer.failure.message, { cause: transient.cause });
        yield* Effect.sleep(retryDelayMs(policy, attempt, transient.retryAfterMs));
        continue;
      }
      const result = output.decode(answer.success);
      if (result.ok) return result.value;
      if (attempt >= policy.attempts) return yield* fail(result.error);
    }
  }).pipe(
    Effect.timeout(stepTimeoutMs(verb, [options]) ?? "10 minutes"),
    Effect.catchTags({ TimeoutError: () => fail("The model step timed out.") }),
  );
};
