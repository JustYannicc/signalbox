import {
  CommandId,
  MessageId,
  RunId,
  type OrchestrationV2ThreadProjection,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { CloudThreadService } from "../../thread/CloudThreadService.ts";
import { ThreadCommandRejectedError } from "../../thread/ThreadEngine.ts";
import { applyEvents } from "../../thread/threadProjection.ts";
import { scriptedStep } from "../../thread/scriptedTurn.ts";
import { recoverRunEvents } from "../../thread/ThreadRecovery.ts";
import { decide } from "../../thread/threadDecider.ts";

export const applyDecision = (
  projection: OrchestrationV2ThreadProjection,
  command: Parameters<typeof decide>[1],
  context: Parameters<typeof decide>[2],
) => {
  const decision = decide(projection, command, context);
  if (decision._tag === "rejected") throw new Error(decision.message);
  const next = applyEvents(projection, decision.events);
  if (next === null) throw new Error("Expected the decider to update the projection.");
  return { projection: next, events: decision.events };
};

export const queuedParent = (
  initial: OrchestrationV2ThreadProjection,
  context: Parameters<typeof decide>[2],
) => {
  const first = applyDecision(
    initial,
    {
      type: "message.dispatch",
      commandId: CommandId.make("parent-root-one"),
      messageId: MessageId.make("parent-message-one"),
      threadId: initial.thread.id,
      text: "Parent run one",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      dispatchMode: { type: "start_immediately" },
    },
    context,
  ).projection;
  const firstStep = scriptedStep(first, context);
  if (firstStep.length === 0) throw new Error("Expected the first parent run to advance.");
  const running = applyEvents(first, firstStep)!;
  const original = running.runs.find((run) => run.ordinal === 1);
  if (original === undefined) throw new Error("Expected the first parent run.");
  const second = applyDecision(
    running,
    {
      type: "message.dispatch",
      commandId: CommandId.make("parent-root-two"),
      messageId: MessageId.make("parent-message-two"),
      threadId: initial.thread.id,
      text: "Parent run two",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      dispatchMode: { type: "queue_after_active" },
    },
    context,
  ).projection;
  return { original, projection: second };
};

export const recoveredQueuedProjection = (
  initial: OrchestrationV2ThreadProjection,
  context: Parameters<typeof decide>[2],
) => {
  let projection = applyDecision(
    initial,
    {
      type: "message.dispatch",
      commandId: CommandId.make("recovered-root-one"),
      messageId: MessageId.make("recovered-message-one"),
      threadId: initial.thread.id,
      text: "Parent run one",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      dispatchMode: { type: "start_immediately" },
    },
    context,
  ).projection;
  const firstStep = scriptedStep(projection, context);
  if (firstStep.length === 0) throw new Error("Expected the first parent run to advance.");
  projection = applyEvents(projection, firstStep)!;
  const original = projection.runs.find((run) => run.ordinal === 1);
  if (original === undefined) throw new Error("Expected the first parent run.");
  projection = applyDecision(
    projection,
    {
      type: "message.dispatch",
      commandId: CommandId.make("recovered-root-two"),
      messageId: MessageId.make("recovered-message-two"),
      threadId: initial.thread.id,
      text: "Parent run two",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      dispatchMode: { type: "queue_after_active" },
    },
    context,
  ).projection;
  return stopRecovery(projection, original, context, false).projection;
};

export const stopRecovery = (
  parent: OrchestrationV2ThreadProjection,
  original: OrchestrationV2ThreadProjection["runs"][number],
  context: Parameters<typeof decide>[2],
  holdQueue: boolean,
) => {
  const recovered = applyEvents(parent, recoverRunEvents(parent, original, context));
  if (recovered === null) throw new Error("Expected the recovery projection.");
  const continuation = recovered.runs.find((run) => run.restartContinuationOfRunId === original.id);
  if (continuation === undefined) throw new Error("Expected a recovery continuation.");
  const stopped = applyDecision(
    recovered,
    {
      type: "run.interrupt",
      commandId: CommandId.make(holdQueue ? "stop-recovery-holding-queue" : "stop-recovery"),
      threadId: parent.thread.id,
      runId: continuation.id,
      holdQueue,
    },
    context,
  );
  return { ...stopped, continuation };
};

export const completeRun = (
  threads: CloudThreadService["Service"],
  actor: Parameters<typeof threads.threadSnapshot>[0],
  threadId: ThreadId,
  runId: RunId,
  context: Parameters<typeof decide>[2],
) =>
  Effect.gen(function* () {
    let projection = (yield* threads.threadSnapshot(actor, threadId)).projection;
    const events: ReturnType<typeof scriptedStep>[number][] = [];
    for (let steps = 0; steps < 20; steps++) {
      if (projection.runs.find((run) => run.id === runId)?.status === "completed")
        return { projection, events };
      const next = scriptedStep(projection, context);
      if (next.length === 0) throw new Error("Expected the run to advance.");
      events.push(...next);
      projection = applyEvents(projection, next)!;
    }
    throw new Error("The run did not complete.");
  });

export const controlledParentThreads = (
  threads: CloudThreadService["Service"],
  parentThreadId: ThreadId,
  initialParent: OrchestrationV2ThreadProjection,
  context: Parameters<typeof decide>[2],
) => {
  let parentProjection = initialParent;
  let childThreadId: ThreadId | null = null;
  let childProjection: OrchestrationV2ThreadProjection | null = null;
  let sequence = 100;
  const receipts = new Map<string, number>();
  const parentDispatchSequences: number[] = [];
  return {
    service: {
      ...threads,
      threadSnapshot: (actor: Parameters<typeof threads.threadSnapshot>[0], threadId: ThreadId) =>
        threads
          .threadSnapshot(actor, threadId)
          .pipe(
            Effect.map((snapshot) =>
              threadId === parentThreadId
                ? { ...snapshot, projection: parentProjection, snapshotSequence: sequence }
                : threadId === childThreadId && childProjection !== null
                  ? { ...snapshot, projection: childProjection }
                  : snapshot,
            ),
          ),
      dispatchCommand: (
        actor: Parameters<typeof threads.dispatchCommand>[0],
        command: Parameters<typeof threads.dispatchCommand>[1],
        expectedRun?: Parameters<typeof threads.dispatchCommand>[2],
      ) => {
        if (!("threadId" in command) || command.threadId !== parentThreadId)
          return threads.dispatchCommand(actor, command, expectedRun);
        const receipt = receipts.get(command.commandId);
        if (receipt !== undefined) {
          parentDispatchSequences.push(receipt);
          return Effect.succeed({ sequence: receipt });
        }
        const decision = decide(
          parentProjection,
          command,
          context,
          expectedRun === undefined ? {} : { run: expectedRun },
        );
        if (decision._tag === "rejected")
          return Effect.fail(
            ThreadCommandRejectedError.forCommand(
              { id: command.commandId, type: command.type },
              decision.message,
              decision.code,
            ),
          );
        parentProjection = applyEvents(parentProjection, decision.events)!;
        sequence += decision.events.length;
        receipts.set(command.commandId, sequence);
        parentDispatchSequences.push(sequence);
        return Effect.succeed({ sequence });
      },
    },
    parent: () => parentProjection,
    setParent: (projection: OrchestrationV2ThreadProjection) => {
      parentProjection = projection;
    },
    child: (id: ThreadId, projection: OrchestrationV2ThreadProjection) => {
      childThreadId = id;
      childProjection = projection;
    },
    parentDispatchSequences,
  };
};
