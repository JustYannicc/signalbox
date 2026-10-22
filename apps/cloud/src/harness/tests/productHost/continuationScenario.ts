import * as NodeAssert from "node:assert/strict";
import type { RunnerItem, RunnerTurn } from "@signalbox/runner-protocol/RunnerProtocol";
import { MessageId, NodeId, RunAttemptId, RunId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { HarnessContinuation } from "../../HarnessContinuations.ts";
import { continuationHostFixture } from "./continuationHost.ts";

const continuationJournalRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      message_id: Schema.String,
      request_json: Schema.String,
      published: Schema.Number,
    }),
  ),
);
const decodeContinuation = Schema.decodeEffect(
  Schema.fromJsonString(Schema.toCodecJson(HarnessContinuation)),
);
const isMessage = Schema.is(
  Schema.Struct({
    type: Schema.Literal("message.updated"),
    message: Schema.Struct({ text: Schema.String }),
  }),
);

export const run = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* continuationHostFixture;
        const initialTerminal = yield* Deferred.make<void>();
        const followupTerminal = yield* Deferred.make<void>();
        const events: RunnerItem[] = [];
        let sourceTurnSettled = false;
        yield* fixture.session.events.pipe(
          Stream.runForEach((item) =>
            Effect.gen(function* () {
              events.push(item);
              if (item.kind !== "provider" || item.event.type !== "turn.terminal") return;
              if (item.runId === fixture.turn.runId) {
                sourceTurnSettled = true;
                yield* Deferred.succeed(initialTerminal, undefined);
              }
              if (item.runId === RunId.make("continuation-run-2")) {
                yield* Deferred.succeed(followupTerminal, undefined);
              }
            }),
          ),
          Effect.forkScoped,
        );

        yield* fixture.session.turn({ turn: fixture.turn, access: fixture.access });
        yield* Deferred.await(initialTerminal);
        yield* Effect.promise(() => fixture.native.waitUntilProcessed("initial-result"));

        fixture.native.releaseWake();
        yield* Effect.promise(() => fixture.native.waitUntilProcessed("buffered-result"));
        NodeAssert.equal(
          fixture.publishedRequests.length,
          1,
          "the public continuation publisher must receive the request after the buffered result is processed",
        );
        NodeAssert.equal(sourceTurnSettled, true);

        const request = fixture.publishedRequests[0];
        NodeAssert.ok(request);
        NodeAssert.equal(request.threadId, fixture.threadId);
        NodeAssert.equal(request.providerThreadId, fixture.providerThreadId);
        NodeAssert.equal(request.sourceRunId, fixture.turn.runId);
        NodeAssert.equal(request.messageId, `message:provider-continuation:${fixture.turn.runId}`);
        NodeAssert.equal(request.detail, "Background lookup finished.");
        NodeAssert.ok(
          request.notification,
          "the task completion notification should reach the publisher",
        );

        NodeAssert.equal(fixture.journalReadFailure, undefined);
        const journalAtPublish = fixture.journalRowsAtPublish.at(-1) ?? [];
        const pendingRows = yield* continuationJournalRows(journalAtPublish);
        const pendingRow = pendingRows.find((row) => row.message_id === request.messageId);
        NodeAssert.ok(pendingRow, "the host must journal the request before publishing it");
        NodeAssert.equal(pendingRow.published, 0);
        NodeAssert.deepEqual(yield* decodeContinuation(pendingRow.request_json), request);

        const followupRunnerTurn: RunnerTurn = {
          ...fixture.turn,
          runId: RunId.make("continuation-run-2"),
          runOrdinal: 2,
          providerTurnOrdinal: 2,
          attemptId: RunAttemptId.make("continuation-attempt-2"),
          rootNodeId: NodeId.make("continuation-root-2"),
          message: {
            messageId: MessageId.make("provider-continuation-followup"),
            text: "Background lookup finished.",
            attachments: [],
            createdBy: "agent",
            creationSource: "provider",
          },
        };
        const userPromptCount = fixture.native.userPromptCount;
        yield* fixture.session.turn({ turn: followupRunnerTurn, access: fixture.access });
        yield* Deferred.await(followupTerminal);
        NodeAssert.equal(fixture.native.userPromptCount, userPromptCount);
        NodeAssert.ok(
          events.some(
            (item) =>
              item.kind === "provider" &&
              item.runId === followupRunnerTurn.runId &&
              isMessage(item.event) &&
              item.event.message.text === "Buffered background task result.",
          ),
          "the buffered native result must be ingested by the follow-up run",
        );
        NodeAssert.ok(fixture.native.queryIdentities.length > 0);
        NodeAssert.ok(
          fixture.native.queryIdentities.every((identity) => identity === fixture.nativeId),
        );
        NodeAssert.equal(fixture.native.sdkIdentity, fixture.nativeId);

        const publishedRows = yield* continuationJournalRows(fixture.readContinuationRows());
        const publishedRow = publishedRows.find((row) => row.message_id === request.messageId);
        NodeAssert.ok(publishedRow);
        NodeAssert.equal(publishedRow.published, 1);
      }),
    ),
  );
