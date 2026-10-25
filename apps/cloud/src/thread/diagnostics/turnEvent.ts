import type {
  OrchestrationV2ProviderFailure,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { createError } from "evlog";
import * as Effect from "effect/Effect";

import * as Evlog from "../../observability/Evlog.ts";
import type { turnCompletedProperties } from "./turnRecord.ts";

/**
 * A turn's wide event (#285), emitted once when the thread closes it
 * (`TurnReports.finalize`): who and where in the shared dimensions, and what
 * the turn did as `cloud.turn.completed` counts it. It carries the turn's
 * trace id, so the record behind it is one diagnostics call away. A turn that
 * ended in an error is an error event, which Sentry files as an issue by its
 * failure class.
 */
export const emitTurnEvent = (input: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly run: OrchestrationV2Run;
  readonly traceId: string;
  readonly owner: string | null;
  readonly failure: Pick<OrchestrationV2ProviderFailure, "class" | "code"> | null;
  readonly properties: ReturnType<typeof turnCompletedProperties>;
}) => {
  const { projection, run, properties } = input;
  // The hashes are for PostHog's product events; the wide event has the ids.
  const { threadHash: _thread, projectHash: _project, provider, model, ...work } = properties;
  const failed = properties.outcome === "error";
  return Effect.gen(function* () {
    if (!failed) return;
    const log = yield* Evlog.logger;
    const failure = input.failure;
    log.error(
      createError({
        message: `Turn failed: ${failure?.class ?? "unknown"}`,
        ...(failure?.code && { why: `The harness reported ${failure.code}.` }),
        fix: `Read the turn's record: GET /api/cloud/threads/${projection.thread.id}/diagnostics/${input.traceId}`,
      }),
    );
  }).pipe(
    Evlog.withUnit("turn", {
      ...(input.owner !== null && { person: { id: input.owner } }),
      thread: { id: projection.thread.id },
      turn: {
        id: run.id,
        traceId: input.traceId,
        ordinal: run.ordinal,
        ...work,
        ...(failed && { failureClass: input.failure?.class ?? "unknown" }),
      },
      provider,
      model,
    }),
  );
};
