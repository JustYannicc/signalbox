import * as NodeAssert from "node:assert/strict";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderContinuationAssociation,
  type RunId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { HarnessContinuation } from "../../HarnessContinuations.ts";
import { createProductClaudeThreadHost } from "../../../thread/ProductClaudeThreadHost.ts";
import {
  boundaryBatchContinuationHostInputs,
  unjoinedBatchContinuationHostInputs,
  nativeBoundBatchContinuationHostInputs,
  batchContinuationHostInputs,
  continuationHostInputs,
} from "./continuationHost.ts";
import { threadActor, threadPlatform } from "./threadPlatform.ts";

const continuationRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ message_id: Schema.String, published: Schema.Number })),
);
const continuationPayloads = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ request_json: Schema.String })),
);
const decodeAssociation = Schema.decodeEffect(
  Schema.fromJsonString(Schema.toCodecJson(ProviderContinuationAssociation)),
);
const associationRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ association_json: Schema.String })),
);
const decodeContinuation = Schema.decodeEffect(
  Schema.fromJsonString(Schema.toCodecJson(HarnessContinuation)),
);

export const run = (
  mode:
    | "continue"
    | "revoke"
    | "startup-failure"
    | "batch"
    | "boundary-batch"
    | "native-bound-batch"
    | "unjoined-batch" = "continue",
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const batchMode =
          mode === "batch" ||
          mode === "boundary-batch" ||
          mode === "native-bound-batch" ||
          mode === "unjoined-batch";
        const knownAtDispatch = mode === "boundary-batch";
        const input = yield* mode === "native-bound-batch"
          ? nativeBoundBatchContinuationHostInputs
          : mode === "unjoined-batch"
            ? unjoinedBatchContinuationHostInputs
            : mode === "boundary-batch"
              ? boundaryBatchContinuationHostInputs
              : mode === "batch"
                ? batchContinuationHostInputs
                : continuationHostInputs;
        const { platform } = yield* threadPlatform;
        let actor = threadActor;
        let startupAttempts = 0;
        const handed: RunId[] = [];
        const handedCompletions: unknown[] = [];
        const binding = yield* createProductClaudeThreadHost({
          threadId: input.threadId,
          sql: NodeSqliteClient.layer({ filename: ":memory:" }),
          platform,
          actor: Effect.sync(() => actor),
          host:
            mode === "startup-failure"
              ? {
                  ...input.hostOptions,
                  native: {
                    ...input.hostOptions.native,
                    loadSdk: async () => {
                      startupAttempts++;
                      throw new Error("Controlled SDK startup failed");
                    },
                  },
                }
              : input.hostOptions,
          open: (work) => {
            NodeAssert.ok(work.turn);
            return {
              session: {
                ...input.sessionInput,
                providerSessionId:
                  work.turn.providerThread.providerSessionId ??
                  input.sessionInput.providerSessionId,
              },
              bootAttemptId: "thread-claude-continuation",
            };
          },
          access: (work) =>
            Effect.sync(() => {
              NodeAssert.ok(work.turn);
              handed.push(work.turn.runId);
              handedCompletions.push(work.turn.message.providerContinuation?.completions);
              input.setRunId(work.turn.runId);
              return input.access;
            }),
        });
        const launching = binding.launch(threadActor, {
          commandId: CommandId.make("launch-thread-claude-continuation"),
          threadId: input.threadId,
          projectId: ProjectId.make("scratch"),
          title: "Claude background continuation",
          modelSelection: input.sessionInput.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: {
            messageId: MessageId.make("initial-thread-claude-message"),
            text: "Run a background lookup.",
            attachments: [],
          },
        });
        if (mode === "startup-failure") {
          yield* Effect.flip(launching);
          yield* Effect.flip(binding.failure);
          yield* Effect.flip(binding.host);
          const before = yield* binding.threads.snapshot(threadActor, input.threadId);
          yield* Effect.flip(
            binding.dispatch(threadActor, {
              type: "message.dispatch",
              threadId: input.threadId,
              commandId: CommandId.make("no-retry-after-startup-failure"),
              messageId: MessageId.make("no-retry-after-startup-failure"),
              text: "This must not restart a failed facet.",
              createdBy: "agent",
              creationSource: "provider",
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
            }),
          );
          const after = yield* binding.threads.snapshot(threadActor, input.threadId);
          NodeAssert.equal(startupAttempts, 1);
          NodeAssert.equal(after.snapshotSequence, before.snapshotSequence);
          yield* binding.dispose;
          return;
        }
        const launched = yield* launching;
        const source = launched.projection.runs[0];
        NodeAssert.ok(source);
        const initialTerminal = yield* Deferred.make<void>();
        const followupTerminal = yield* Deferred.make<void>();
        const completed = new Set<RunId>();
        yield* binding.threads.subscribe(threadActor, { threadId: input.threadId }).pipe(
          Stream.runForEach((batch) =>
            Effect.gen(function* () {
              for (const item of batch) {
                const runs =
                  item.kind === "snapshot"
                    ? item.projection.runs
                    : item.kind === "event" && item.event.type === "run.updated"
                      ? [item.event.payload]
                      : [];
                for (const run of runs) {
                  if (run.status !== "completed") continue;
                  completed.add(run.id);
                  yield* Deferred.succeed(
                    run.id === source.id ? initialTerminal : followupTerminal,
                    undefined,
                  );
                }
              }
            }),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(initialTerminal).pipe(Effect.raceFirst(binding.failure));
        yield* Effect.promise(() => input.native.waitUntilProcessed("initial-result"));
        const nativeId = input.native.sdkIdentity;
        NodeAssert.ok(nativeId);
        const promptCount = input.native.userPromptCount;
        const beforeWake = (yield* binding.threads.snapshot(threadActor, input.threadId))
          .snapshotSequence;
        if (mode === "revoke") actor = { ...threadActor, userId: "replacement-owner" };
        input.native.releaseWake();
        if (mode === "revoke") {
          const failure = yield* Effect.flip(binding.failure);
          NodeAssert.equal(failure.operation, "events");
          const snapshot = yield* binding.threads.snapshot(threadActor, input.threadId);
          NodeAssert.equal(snapshot.projection.runs.length, 1);
          NodeAssert.deepEqual(handed, [source.id]);
          yield* binding.dispose;
          return;
        }
        yield* Deferred.await(followupTerminal).pipe(Effect.raceFirst(binding.failure));
        const snapshot = yield* binding.threads.snapshot(threadActor, input.threadId);
        const runs = snapshot.projection.runs;
        NodeAssert.equal(runs.length, 2);
        NodeAssert.equal(completed.size, 2);
        NodeAssert.deepEqual(
          handed,
          runs.map((run) => run.id),
        );
        NodeAssert.ok(runs.every((run) => run.status === "completed"));
        NodeAssert.equal(runs[0]!.providerThreadId, runs[1]!.providerThreadId);
        NodeAssert.equal(snapshot.projection.providerThreads.length, 1);
        NodeAssert.equal(
          snapshot.projection.providerThreads[0]!.nativeThreadRef?.nativeId,
          nativeId,
        );
        const continuation = snapshot.projection.messages.find((message) =>
          batchMode
            ? message.providerContinuation?.observations !== undefined
            : message.id === `message:provider-continuation:${source.id}`,
        );
        NodeAssert.ok(continuation);
        NodeAssert.equal(continuation.runId, runs[1]!.id);
        NodeAssert.equal(continuation.creationSource, "provider");
        NodeAssert.equal(continuation.text, "Background lookup finished.");
        if (!batchMode)
          NodeAssert.equal(
            continuation.notification?.summary,
            'Subagent "Background lookup" finished',
          );
        NodeAssert.ok(
          snapshot.projection.messages.some(
            (message) => message.text === "Buffered background task result.",
          ),
        );
        NodeAssert.equal(input.native.userPromptCount, promptCount);
        NodeAssert.equal(input.native.queryIdentities.length, 1);
        NodeAssert.equal(input.native.sdkIdentity, nativeId);
        if (batchMode) {
          const expectedObservations = input.native.batchBlocks.map((block, index) => ({
            sdkMessageId: input.native.batchUuid,
            blockIndex: index,
            observedCallId: input.native.batchCalls[index],
            block,
          }));
          const expected =
            mode === "unjoined-batch"
              ? undefined
              : input.native.batchBlocks.map((block, index) => ({
                  sourceCallId: input.batchBindings[index]!.sourceCallId,
                  sourceOccurrenceId: input.batchBindings[index]!.sourceOccurrenceId,
                  observation: { sdkMessageId: input.native.batchUuid, blockIndex: index },
                  block,
                }));
          NodeAssert.deepEqual(
            continuation.providerContinuation?.observations,
            expectedObservations,
          );
          NodeAssert.deepEqual(continuation.providerContinuation?.completions, expected);
          NodeAssert.deepEqual(handedCompletions, [
            undefined,
            knownAtDispatch ? expected : undefined,
          ]);
          const payloads = yield* continuationPayloads(input.readContinuationRows());
          NodeAssert.equal(payloads.length, 1);
          const journaledRequest = yield* decodeContinuation(payloads[0]!.request_json);
          NodeAssert.deepEqual(
            journaledRequest.completions,
            knownAtDispatch ? expected : undefined,
          );
          const associated = yield* associationRows(input.readContinuationAssociations());
          NodeAssert.deepEqual(
            journaledRequest.observations,
            knownAtDispatch ? expectedObservations : undefined,
          );
          NodeAssert.equal(associated.length, knownAtDispatch ? 0 : 1);
          if (!knownAtDispatch) {
            const association = yield* decodeAssociation(associated[0]!.association_json);
            NodeAssert.equal(association.messageId, continuation.id);
            NodeAssert.equal(association.runId, runs[1]!.id);
            NodeAssert.deepEqual(association.providerContinuation.completions, expected);
            NodeAssert.deepEqual(
              association.providerContinuation.observations,
              expectedObservations,
            );
          }
          const beforeReplay = snapshot.snapshotSequence;
          const replay = yield* binding.threads
            .subscribe(threadActor, {
              threadId: input.threadId,
              afterSequence: beforeWake,
              requestCompletionMarker: true,
            })
            .pipe(
              Stream.flattenIterable,
              Stream.takeUntil((item) => item.kind === "synchronized"),
              Stream.runCollect,
            );
          const replayed = replay.flatMap((item) =>
            item.kind === "event" &&
            item.event.type === "message.updated" &&
            item.event.payload.id === continuation.id
              ? [item.event.payload.providerContinuation]
              : [],
          );
          NodeAssert.ok(replayed.length > 0);
          NodeAssert.deepEqual(replayed[0]?.completions, knownAtDispatch ? expected : undefined);
          NodeAssert.deepEqual(replayed.at(-1)?.completions, expected);
          NodeAssert.deepEqual(replayed.at(-1)?.observations, expectedObservations);
          NodeAssert.equal(
            snapshot.projection.messages.filter(
              (message) => message.providerContinuation?.observations !== undefined,
            ).length,
            1,
          );
          NodeAssert.equal(
            (yield* binding.threads.snapshot(threadActor, input.threadId)).snapshotSequence,
            beforeReplay,
          );
        }
        NodeAssert.deepEqual(yield* continuationRows(input.readContinuationRows()), [
          { message_id: continuation.id, published: 1 },
        ]);
        yield* binding.dispose;
      }),
    ),
  );
