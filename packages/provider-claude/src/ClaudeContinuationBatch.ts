import {
  ProviderContinuationCompletion,
  ProviderContinuationObservation,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
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

type ObservationNotification = {
  readonly task_id?: unknown;
  readonly tool_use_id?: unknown;
};

const TaskStartedFrame = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.Literal("task_started"),
  task_id: ProviderContinuationCompletion.fields.sourceOccurrenceId,
  run_id: ProviderContinuationCompletion.fields.sourceOccurrenceId,
  tool_use_id: ProviderContinuationCompletion.fields.sourceCallId,
});
const TaskNotificationFrame = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.Literal("task_notification"),
  task_id: ProviderContinuationCompletion.fields.sourceOccurrenceId,
  run_id: ProviderContinuationCompletion.fields.sourceOccurrenceId,
  tool_use_id: ProviderContinuationCompletion.fields.sourceCallId,
});
type TaskNotificationIdentity = typeof TaskNotificationFrame.Type;
type TaskIdentity = {
  readonly task_id: string;
  readonly run_id: string;
  readonly tool_use_id: string;
};
const decodeStartedFrame = Schema.decodeUnknownOption(TaskStartedFrame);
const decodeNotificationFrame = Schema.decodeUnknownOption(TaskNotificationFrame);

const taskNotificationHeader = (text: string): string | undefined => {
  if (
    text.split("<task-notification>").length !== 2 ||
    text.split("</task-notification>").length !== 2
  ) {
    return;
  }
  const start = text.indexOf("<task-notification>") + "<task-notification>".length;
  const end = text.indexOf("</task-notification>", start);
  if (end < start) return;
  const body = text.slice(start, end);
  const resultStart = body.indexOf("<result>");
  return resultStart < 0 ? body : body.slice(0, resultStart);
};

const field = (header: string | undefined, name: "task-id" | "tool-use-id") => {
  if (header === undefined) return;
  const matches = [...header.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, "g"))];
  if (matches.length !== 1) return;
  const value = matches[0]![1];
  return value !== undefined && value.trim().length > 0 ? value : undefined;
};

const identityKey = ({ task_id, run_id, tool_use_id }: TaskIdentity) =>
  JSON.stringify([task_id, run_id, tool_use_id]);

const taskCallKey = (taskId: string, toolUseId: string) => JSON.stringify([taskId, toolUseId]);

const sourcePairKey = (callId: string, occurrenceId: string) =>
  JSON.stringify([callId, occurrenceId]);

/** Extracts only SDK-observed blocks and call IDs. It does not identify recorded source events. */
export function claudeContinuationObservations(input: {
  readonly uuid: string | undefined;
  readonly content: unknown;
  readonly notifications: ReadonlyArray<ObservationNotification>;
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
    const header = taskNotificationHeader(block.text);
    if (header === undefined) {
      throw new Error("Claude observation batch has an unowned content block.");
    }
    const taskId = field(header, "task-id");
    const callId = field(header, "tool-use-id");
    const matching = input.notifications.filter(
      (notification) =>
        typeof notification.task_id === "string" &&
        taskId !== undefined &&
        notification.task_id === taskId &&
        (callId === undefined || notification.tool_use_id === callId),
    );
    const observedCallIds = new Set(
      matching.flatMap((entry) =>
        typeof entry.tool_use_id === "string" && entry.tool_use_id.trim().length > 0
          ? [entry.tool_use_id]
          : [],
      ),
    );
    const observedCallId =
      observedCallIds.size === 1 ? observedCallIds.values().next().value : undefined;
    return {
      sdkMessageId: input.uuid,
      blockIndex,
      ...(observedCallId === undefined ? {} : { observedCallId }),
      block,
    };
  });
  return decodeObservations(observations);
}

/** Joins each observed CLI block through its task notification and matching task start. */
export function resolveClaudeContinuationOwnership(
  observationsInput: ClaudeContinuationObservationBatch,
  input: {
    readonly started: ReadonlyArray<unknown>;
    readonly notifications: ReadonlyArray<unknown>;
  },
): ReadonlyArray<ClaudeContinuationOwnershipBinding> | undefined {
  const observations = decodeObservations(observationsInput);
  const started = new Set(
    input.started.flatMap((frame) => Option.toArray(decodeStartedFrame(frame))).map(identityKey),
  );
  const notificationsByTaskCall = new Map<string, Map<string, TaskNotificationIdentity>>();
  for (const notification of input.notifications.flatMap((frame) =>
    Option.toArray(decodeNotificationFrame(frame)),
  )) {
    const key = taskCallKey(notification.task_id, notification.tool_use_id);
    const candidates = notificationsByTaskCall.get(key) ?? new Map();
    candidates.set(identityKey(notification), notification);
    notificationsByTaskCall.set(key, candidates);
  }

  const usedSourcePairs = new Set<string>();
  const bindings: ClaudeContinuationOwnershipBinding[] = [];
  for (const observation of observations) {
    const header = taskNotificationHeader(observation.block.text);
    const taskId = field(header, "task-id");
    const toolUseId = field(header, "tool-use-id");
    if (
      taskId === undefined ||
      toolUseId === undefined ||
      (observation.observedCallId !== undefined && observation.observedCallId !== toolUseId)
    ) {
      return;
    }

    const candidates = notificationsByTaskCall.get(taskCallKey(taskId, toolUseId));
    if (candidates === undefined || candidates.size !== 1) return;
    const notification = candidates.values().next().value;
    if (
      notification === undefined ||
      (observation.observedCallId !== undefined &&
        observation.observedCallId !== notification.tool_use_id) ||
      !started.has(identityKey(notification))
    ) {
      return;
    }

    const sourcePair = sourcePairKey(notification.tool_use_id, notification.task_id);
    if (usedSourcePairs.has(sourcePair)) return;
    usedSourcePairs.add(sourcePair);
    bindings.push({
      sdkMessageId: observation.sdkMessageId,
      blockIndex: observation.blockIndex,
      sourceCallId: notification.tool_use_id,
      sourceOccurrenceId: notification.task_id,
    });
  }

  return bindings;
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
