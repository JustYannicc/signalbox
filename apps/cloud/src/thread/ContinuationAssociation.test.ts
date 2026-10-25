import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  RunId,
  type ProviderContinuationAssociation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import {
  freshDatabase,
  withObject,
  launch,
  connect,
  liveTurn,
  turnReport,
  owner,
  personal,
  threadId,
  recordedEvents,
  now,
} from "./runnerTesting.ts";

it.effect(
  "persists an owned late batch on the existing run, fences conflicting associations, and replays it after eviction",
  () => {
    const filename = freshDatabase();
    return Effect.gen(function* () {
      const association = yield* withObject(filename, (engine, runner) =>
        Effect.gen(function* () {
          yield* launch(engine);
          const machine = yield* connect(runner);
          const initial = yield* liveTurn(runner);
          const report = turnReport(initial.runId, initial.runOrdinal, initial.providerThread);
          yield* runner.batch({
            generation: machine.generation,
            sequence: 1,
            items: [report.started, report.terminal],
          });
          const providerContinuation = {
            sourceRunId: initial.runId,
            providerThreadId: initial.providerThread.id,
            driver: initial.providerThread.driver,
          };
          const messageId = MessageId.make("early-wake");
          yield* engine.dispatch(
            owner,
            {
              type: "message.dispatch",
              commandId: CommandId.make("early-wake"),
              threadId,
              messageId,
              createdBy: "agent",
              creationSource: "provider",
              text: "Background work finished.",
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              providerContinuation,
            },
            personal,
          );
          const turn = yield* liveTurn(runner);
          expect(turn.message.providerContinuation).toEqual(providerContinuation);
          const started = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
          yield* runner.batch({
            generation: machine.generation,
            sequence: 2,
            items: [started.started],
          });
          const association = {
            threadId,
            runId: turn.runId,
            messageId,
            providerContinuation: {
              ...providerContinuation,
              observations: [
                {
                  sdkMessageId: "observed-batch",
                  blockIndex: 0,
                  observedCallId: "observed-call-a",
                  block: { type: "text", text: "Exact first.\r\n" },
                },
                {
                  sdkMessageId: "observed-batch",
                  blockIndex: 1,
                  observedCallId: "observed-call-b",
                  block: { type: "text", text: "Exact second.\n" },
                },
                {
                  sdkMessageId: "observed-batch",
                  blockIndex: 2,
                  observedCallId: "observed-call-c",
                  block: {
                    type: "text",
                    text: "Exact final.\n",
                    cache_control: { type: "ephemeral" },
                  },
                },
              ],
              completions: [
                {
                  observation: { sdkMessageId: "observed-batch", blockIndex: 0 },
                  sourceCallId: "call-a",
                  sourceOccurrenceId: "recorded-enqueue:131:fixture-digest-a",
                  block: { type: "text", text: "Exact first.\r\n" },
                },
                {
                  observation: { sdkMessageId: "observed-batch", blockIndex: 1 },
                  sourceCallId: "call-b",
                  sourceOccurrenceId: "recorded-enqueue:130:fixture-digest-b",
                  block: { type: "text", text: "Exact second.\n" },
                },
                {
                  observation: { sdkMessageId: "observed-batch", blockIndex: 2 },
                  sourceCallId: "call-c",
                  sourceOccurrenceId: "recorded-enqueue:164:fixture-digest-c",
                  block: {
                    type: "text",
                    text: "Exact final.\n",
                    cache_control: { type: "ephemeral" },
                  },
                },
              ],
            },
          } satisfies ProviderContinuationAssociation;
          const event = {
            type: "continuation.associated",
            driver: initial.providerThread.driver,
            association,
          };
          const projection = (yield* engine.snapshot(owner)).projection;
          for (const invalid of [
            { ...association, runId: initial.runId },
            { ...association, messageId: MessageId.make("message-1") },
            {
              ...association,
              providerContinuation: {
                ...association.providerContinuation,
                sourceRunId: RunId.make("foreign-source"),
              },
            },
            {
              ...association,
              providerContinuation: {
                ...association.providerContinuation,
                completions: [
                  association.providerContinuation.completions[0],
                  association.providerContinuation.completions[0],
                ],
              },
            },
          ])
            expect(
              recordedEvents(
                projection,
                { kind: "provider", runId: turn.runId, event: { ...event, association: invalid } },
                turn.runId,
                { now },
              ),
            ).toBe("undecodable");
          yield* runner.batch({
            generation: machine.generation,
            sequence: 3,
            items: [
              {
                kind: "provider",
                runId: turn.runId,
                event: {
                  ...event,
                  association: {
                    ...association,
                    providerContinuation: {
                      ...association.providerContinuation,
                      completions: undefined,
                    },
                  },
                },
              },
            ],
          });
          const unjoined = (yield* engine.snapshot(owner)).projection.messages.find(
            (message) => message.id === messageId,
          )?.providerContinuation;
          expect(unjoined?.observations).toEqual(association.providerContinuation.observations);
          expect(unjoined?.completions).toBeUndefined();
          yield* runner.batch({
            generation: machine.generation,
            sequence: 4,
            items: [{ kind: "provider", runId: turn.runId, event }],
          });
          const after = yield* engine.snapshot(owner);
          expect(after.projection.runs).toHaveLength(2);
          expect(
            after.projection.messages.find((message) => message.id === messageId)
              ?.providerContinuation,
          ).toEqual(association.providerContinuation);
          expect(
            recordedEvents(
              after.projection,
              { kind: "provider", runId: turn.runId, event },
              turn.runId,
              { now },
            ),
          ).toEqual([]);
          const changed = {
            ...association,
            providerContinuation: {
              ...association.providerContinuation,
              completions: [
                {
                  ...association.providerContinuation.completions[0],
                  block: { type: "text", text: "conflicting" },
                },
              ],
            },
          };
          expect(
            recordedEvents(
              after.projection,
              { kind: "provider", runId: turn.runId, event: { ...event, association: changed } },
              turn.runId,
              { now },
            ),
          ).toBe("undecodable");
          return association;
        }),
      );
      yield* withObject(filename, (engine) =>
        Effect.gen(function* () {
          const snapshot = yield* engine.snapshot(owner);
          expect(snapshot.projection.runs).toHaveLength(2);
          expect(
            snapshot.projection.messages.find((message) => message.id === association.messageId)
              ?.providerContinuation,
          ).toEqual(association.providerContinuation);
        }),
      );
    });
  },
);
