import { runnerFrame } from "@signalbox/runner-protocol/RunnerProtocol";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import { makeSubagentChildThread } from "@t3tools/provider-core/server/subagentProjection";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { runnerBatchEvents } from "../ThreadRunnerProof.ts";
import {
  owner,
  personal,
  connect,
  freshDatabase,
  launch,
  liveTurn,
  snapshot,
  turnReport,
  withObject,
} from "../ThreadTestKit.ts";

const encodeAdapterEvent = Schema.encodeUnknownSync(Schema.toCodecJson(ProviderAdapterV2Event));
const decodeRecord = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));

describe("native child creation transport", () => {
  it.effect.each([
    { instanceId: "claudeAgent", driver: "claudeAgent" },
    { instanceId: "claude_hub", driver: "claudeAgent" },
    { instanceId: "codex_hub_team", driver: "codex" },
  ])(
    "captures and saves native children for $instanceId after the Runner wire round trip",
    ({ instanceId, driver }) => {
      const childDatabase = freshDatabase();
      return withObject(
        freshDatabase(),
        (engine, runner) =>
          Effect.gen(function* () {
            yield* launch(engine, "launch-1", personal, {
              modelSelection: {
                instanceId: ProviderInstanceId.make(instanceId),
                model: "native-model",
              },
            });
            const machine = yield* connect(runner);
            const turn = yield* liveTurn(runner);
            const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
            yield* runner.batch({
              generation: machine.generation,
              sequence: 1,
              items: [
                {
                  ...report.started,
                  providerSession: {
                    ...report.started.providerSession,
                    driver: ProviderDriverKind.make(driver),
                    providerInstanceId: turn.modelSelection.instanceId,
                  },
                  providerThread: {
                    ...report.started.providerThread,
                    nativeThreadRef: {
                      driver: ProviderDriverKind.make(driver),
                      nativeId: "native-session",
                      strength: "strong",
                    },
                  },
                },
              ],
            });
            const parent = (yield* snapshot(engine)).projection;
            const now = parent.thread.updatedAt;
            const childThreadId = ThreadId.make("native-wire-child");
            const childProviderId = ProviderThreadId.make("native-wire-provider");
            const subagentId = NodeId.make("native-wire-task");
            const appThread = makeSubagentChildThread({
              parentThread: parent.thread,
              childThreadId,
              parentNodeId: subagentId,
              activeProviderThreadId: childProviderId,
              providerInstanceId: turn.modelSelection.instanceId,
              modelSelection: turn.modelSelection,
              title: "Native wire child",
              now,
              createdBy: "agent",
              creationSource: "provider",
            });
            expect(appThread).toHaveProperty("historyOrigin", undefined);
            const attestation = {
              id: subagentId,
              threadId: parent.thread.id,
              runId: turn.runId,
              parentNodeId: parent.runs[0]!.rootNodeId!,
              origin: "provider_native" as const,
              createdBy: "agent" as const,
              driver: ProviderDriverKind.make(driver),
              providerInstanceId: turn.modelSelection.instanceId,
              providerThreadId: childProviderId,
              childThreadId,
              nativeTaskRef: null,
              prompt: "Reply with the marker",
              title: "Native wire child",
              model: parent.thread.modelSelection.model,
              status: "running" as const,
              result: null,
              startedAt: now,
              completedAt: null,
              updatedAt: now,
            };
            const frame = runnerFrame.decode(
              runnerFrame.encode({
                type: "batch",
                sequence: 2,
                items: [
                  {
                    kind: "provider",
                    runId: turn.runId,
                    event: decodeRecord(
                      encodeAdapterEvent({
                        type: "subagent.updated",
                        driver: ProviderDriverKind.make(driver),
                        subagent: attestation,
                      }),
                    ),
                  },
                  {
                    kind: "provider",
                    runId: turn.runId,
                    event: decodeRecord(
                      encodeAdapterEvent({
                        type: "app_thread.created",
                        driver: ProviderDriverKind.make(driver),
                        appThread,
                      }),
                    ),
                  },
                ],
              }),
            );
            if (frame.type !== "batch") throw new Error("Expected a Runner batch");
            const captured = runnerBatchEvents(parent, frame.items, {
              now,
            });
            expect(captured.nativeChildDiagnostics).toEqual([]);
            expect(captured.undecodable).toEqual([]);
            expect(captured.events.map((event) => event.type)).toContain("subagent.updated");
            expect(captured.nativeChildren.map((child) => child.childThreadId)).toEqual([
              childThreadId,
            ]);
            expect(captured.nativeChildren[0]?.attestation.providerInstanceId).toBe(
              parent.runs[0]!.providerInstanceId,
            );
            const otherInstanceId = ProviderInstanceId.make(
              driver === "codex" ? "claudeAgent" : "codex",
            );
            for (const [forgedThread, reason] of [
              [{ ...appThread, providerInstanceId: otherInstanceId }, "creation_provider_mismatch"],
              [
                {
                  ...appThread,
                  modelSelection: { ...appThread.modelSelection, instanceId: otherInstanceId },
                },
                "creation_model_mismatch",
              ],
            ] as const) {
              const rejected = runnerBatchEvents(
                parent,
                [
                  frame.items[0]!,
                  {
                    kind: "provider",
                    runId: turn.runId,
                    event: decodeRecord(
                      encodeAdapterEvent({
                        type: "app_thread.created",
                        driver: ProviderDriverKind.make(driver),
                        appThread: forgedThread,
                      }),
                    ),
                  },
                  {
                    kind: "provider",
                    runId: turn.runId,
                    event: {
                      type: "turn.terminal",
                      driver,
                      runOrdinal: turn.runOrdinal,
                      status: "completed",
                    },
                  },
                ],
                { now },
              );
              expect(rejected.nativeChildren).toEqual([]);
              expect(rejected.nativeChildDiagnostics).toEqual([
                { runId: turn.runId, reason, count: 1 },
              ]);
            }
            expect(
              yield* runner.batch({
                generation: machine.generation,
                sequence: 2,
                items: frame.items,
              }),
            ).toEqual({ _tag: "ack", sequence: 2 });
            const saved = yield* withObject(childDatabase, (child) => child.snapshot(owner));
            expect(saved.projection.thread).toMatchObject({
              id: childThreadId,
              providerInstanceId: turn.modelSelection.instanceId,
              modelSelection: turn.modelSelection,
              lineage: { parentThreadId: parent.thread.id, relationshipToParent: "subagent" },
            });
            expect(saved.projection.runs).toEqual([]);
            expect(
              yield* runner.batch({
                generation: machine.generation,
                sequence: 2,
                items: frame.items,
              }),
            ).toEqual({ _tag: "ack", sequence: 2 });
            expect(
              (yield* withObject(childDatabase, (child) => child.snapshot(owner))).snapshotSequence,
            ).toBe(saved.snapshotSequence);
          }),
        {
          nativeChildRelay: {
            save: (input) =>
              withObject(childDatabase, (child) => child.recordNativeChildBatch(input)).pipe(
                Effect.orDie,
              ),
          },
        },
      );
    },
  );
});
