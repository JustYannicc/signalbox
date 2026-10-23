import {
  ProviderContinuationCompletion,
  ProviderContinuationObservation,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

type NonEmpty<T> = readonly [T, ...T[]];

export type ClaudeContinuationObservationBatch = NonEmpty<ProviderContinuationObservation>;

export type ClaudeContinuationOwnershipBinding = {
  readonly sdkMessageId: string;
  readonly blockIndex: number;
  readonly sourceCallId: string;
  readonly sourceOccurrenceId: string;
};

export type ClaudeContinuationCompletionBatch = NonEmpty<ProviderContinuationCompletion>;

const decodeBlocks = Schema.decodeUnknownSync(
  Schema.Array(ProviderContinuationCompletion.fields.block),
);
const decodeObservations = Schema.decodeUnknownSync(
  Schema.NonEmptyArray(ProviderContinuationObservation),
);
const decodeBindings = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      sdkMessageId: ProviderContinuationObservation.fields.sdkMessageId,
      blockIndex: ProviderContinuationObservation.fields.blockIndex,
      sourceCallId: ProviderContinuationCompletion.fields.sourceCallId,
      sourceOccurrenceId: ProviderContinuationCompletion.fields.sourceOccurrenceId,
    }),
  ),
);
const decodeCompletions = Schema.decodeUnknownSync(
  Schema.NonEmptyArray(ProviderContinuationCompletion),
);

type Notification = {
  readonly task_id: string;
  readonly tool_use_id?: string;
};

const field = (text: string, name: "task-id" | "tool-use-id") => {
  const matches = [...text.matchAll(new RegExp(`<${name}>([^<]+)</${name}>`, "g"))];
  return matches.length === 1 ? matches[0]![1] : undefined;
};

/** Extracts only SDK-observed blocks and call IDs. It does not identify recorded source events. */
export function claudeContinuationObservations(input: {
  readonly uuid: string | undefined;
  readonly content: unknown;
  readonly notifications: ReadonlyArray<Notification>;
}): ClaudeContinuationObservationBatch | undefined {
  if (
    !Array.isArray(input.content) ||
    !input.content.some((block: unknown) => {
      if (typeof block !== "object" || block === null) return false;
      const text: unknown = Reflect.get(block, "text");
      return typeof text === "string" && text.includes("<task-notification>");
    })
  ) {
    return;
  }
  const blocks = decodeBlocks(input.content);
  if (input.uuid === undefined || input.uuid.trim().length === 0)
    throw new Error("Claude observation batch has no SDK message identity.");
  const observations = blocks.map((block, blockIndex) => {
    if (
      block.text.split("<task-notification>").length !== 2 ||
      block.text.split("</task-notification>").length !== 2
    ) {
      throw new Error("Claude observation batch has an unowned content block.");
    }
    const taskId = field(block.text, "task-id");
    const callId = field(block.text, "tool-use-id");
    const matching = input.notifications.filter(
      (notification) =>
        taskId !== undefined &&
        notification.task_id === taskId &&
        (callId === undefined || notification.tool_use_id === callId),
    );
    const observedCallIds = new Set(matching.flatMap((entry) => entry.tool_use_id ?? []));
    if (matching.length !== 1 || observedCallIds.size !== 1)
      throw new Error("Claude observation batch does not have one observed SDK call.");
    const observedCallId = observedCallIds.values().next().value;
    if (observedCallId === undefined || observedCallId.trim().length === 0)
      throw new Error("Claude observation batch has no observed SDK call ID.");
    return {
      sdkMessageId: input.uuid,
      blockIndex,
      observedCallId,
      block,
    };
  });
  return decodeObservations(observations);
}

/** Binds SDK observations only through explicit producer-recorded source keys. */
export function bindClaudeContinuationCompletions(
  observationsInput: ClaudeContinuationObservationBatch,
  bindingsInput: ReadonlyArray<ClaudeContinuationOwnershipBinding>,
): ClaudeContinuationCompletionBatch {
  const observations = decodeObservations(observationsInput);
  const bindings = decodeBindings(bindingsInput);
  const observationsByMessage = new Map<string, Map<number, (typeof observations)[number]>>();
  for (const observation of observations) {
    const byBlock = observationsByMessage.get(observation.sdkMessageId) ?? new Map();
    if (byBlock.has(observation.blockIndex))
      throw new Error("Claude observation batch has a duplicate SDK block reference.");
    byBlock.set(observation.blockIndex, observation);
    observationsByMessage.set(observation.sdkMessageId, byBlock);
  }

  const bindingsByMessage = new Map<string, Map<number, (typeof bindings)[number]>>();
  const sourcePairs = new Map<string, Set<string>>();
  for (const binding of bindings) {
    const observation = observationsByMessage.get(binding.sdkMessageId)?.get(binding.blockIndex);
    if (observation === undefined)
      throw new Error("Claude ownership binding references a foreign SDK block.");
    const byBlock = bindingsByMessage.get(binding.sdkMessageId) ?? new Map();
    if (byBlock.has(binding.blockIndex))
      throw new Error("Claude ownership binding duplicates an SDK block reference.");
    byBlock.set(binding.blockIndex, binding);
    bindingsByMessage.set(binding.sdkMessageId, byBlock);
    const occurrences = sourcePairs.get(binding.sourceCallId) ?? new Set<string>();
    if (occurrences.has(binding.sourceOccurrenceId))
      throw new Error("Claude ownership bindings contain a duplicate source pair.");
    occurrences.add(binding.sourceOccurrenceId);
    sourcePairs.set(binding.sourceCallId, occurrences);
  }
  if (bindings.length !== observations.length)
    throw new Error("Claude ownership bindings do not cover every observed SDK block.");

  return decodeCompletions(
    observations.map((observation) => {
      const binding = bindingsByMessage.get(observation.sdkMessageId)?.get(observation.blockIndex);
      if (binding === undefined)
        throw new Error("Claude ownership bindings do not cover every observed SDK block.");
      return {
        sourceCallId: binding.sourceCallId,
        sourceOccurrenceId: binding.sourceOccurrenceId,
        block: observation.block,
        observation: {
          sdkMessageId: observation.sdkMessageId,
          blockIndex: observation.blockIndex,
        },
      };
    }),
  );
}
