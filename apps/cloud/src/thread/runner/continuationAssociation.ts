import {
  continuationBlocksMatchObservations,
  ProviderContinuation,
  ProviderContinuationAssociation,
  type OrchestrationV2ThreadProjection,
  type RunId,
} from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { driverFor } from "../../models/ModelRouting.ts";
import { messageEvent, type DecisionContext } from "../threadEvents.ts";

const decode = Schema.decodeUnknownExit(ProviderContinuationAssociation);
const same = Schema.toEquivalence(ProviderContinuation);

/** A late batch enriches the wake message already handed to this Runner. */
export const continuationAssociationEvents = (
  projection: OrchestrationV2ThreadProjection,
  runId: RunId,
  event: Record<string, unknown>,
  ctx: DecisionContext,
) => {
  const decoded = decode(event.association);
  if (Exit.isFailure(decoded)) return "undecodable" as const;
  const association = decoded.value;
  const run = projection.runs.find((entry) => entry.id === runId);
  const message = projection.messages.find((entry) => entry.id === association.messageId);
  const previous = message?.providerContinuation;
  const continuation = association.providerContinuation;
  if (
    run === undefined ||
    message === undefined ||
    previous === undefined ||
    association.threadId !== projection.thread.id ||
    association.runId !== run.id ||
    message.runId !== run.id ||
    run.userMessageId !== message.id ||
    run.providerThreadId !== continuation.providerThreadId ||
    projection.thread.activeProviderThreadId !== continuation.providerThreadId ||
    event.driver !== driverFor(run.providerInstanceId) ||
    previous.sourceRunId !== continuation.sourceRunId ||
    previous.providerThreadId !== continuation.providerThreadId ||
    previous.driver !== continuation.driver ||
    message.createdBy !== "agent" ||
    message.creationSource !== "provider"
  )
    return "undecodable" as const;
  if (!continuationBlocksMatchObservations(continuation)) return "undecodable" as const;
  if (
    previous.observations !== undefined &&
    !same(previous, { ...continuation, completions: previous.completions })
  )
    return "undecodable" as const;
  const observedIdentities = new Set<string>();
  for (const observation of continuation.observations) {
    const identity = JSON.stringify([observation.sdkMessageId, observation.blockIndex]);
    if (observedIdentities.has(identity)) return "undecodable" as const;
    observedIdentities.add(identity);
  }
  const identities = new Set<string>();
  for (const completion of continuation.completions ?? []) {
    const identity = JSON.stringify([completion.sourceCallId, completion.sourceOccurrenceId]);
    if (identities.has(identity)) return "undecodable" as const;
    identities.add(identity);
  }
  if (
    projection.messages.some(
      (entry) =>
        entry.id !== message.id &&
        entry.providerContinuation?.providerThreadId === continuation.providerThreadId &&
        (entry.providerContinuation.completions?.some((completion) =>
          identities.has(JSON.stringify([completion.sourceCallId, completion.sourceOccurrenceId])),
        ) ||
          entry.providerContinuation.observations?.some((observation) =>
            observedIdentities.has(
              JSON.stringify([observation.sdkMessageId, observation.blockIndex]),
            ),
          )),
    )
  )
    return "undecodable" as const;
  if (same(previous, continuation)) return [];
  if (previous.completions !== undefined) return "undecodable" as const;
  return [
    messageEvent(ctx, { ...message, providerContinuation: continuation, updatedAt: ctx.now }),
  ];
};
