import { runnerFrame } from "@signalbox/runner-protocol/RunnerProtocol";
import { NodeId, ProviderThreadId, ThreadId } from "@t3tools/contracts";
import { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import { makeSubagentChildThread } from "@t3tools/provider-core/server/subagentProjection";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { runnerBatchEvents } from "../ThreadRunnerProof.ts";
import {
  claudeDriver,
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
  it.effect("captures the provider's child creation after the Runner wire round trip", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const machine = yield* connect(runner);
        const turn = yield* liveTurn(runner);
        const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
        yield* runner.batch({
          generation: machine.generation,
          sequence: 1,
          items: [report.started],
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
          providerInstanceId: parent.thread.providerInstanceId,
          modelSelection: parent.thread.modelSelection,
          title: "Native wire child",
          now,
          createdBy: "agent",
          creationSource: "provider",
        });
        const attestation = {
          id: subagentId,
          threadId: parent.thread.id,
          runId: turn.runId,
          parentNodeId: parent.runs[0]!.rootNodeId!,
          origin: "provider_native" as const,
          createdBy: "agent" as const,
          driver: claudeDriver,
          providerInstanceId: parent.thread.providerInstanceId,
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
                    type: "app_thread.created",
                    driver: claudeDriver,
                    appThread,
                  }),
                ),
              },
            ],
          }),
        );
        if (frame.type !== "batch") throw new Error("Expected a Runner batch");
        const captured = runnerBatchEvents({ ...parent, subagents: [attestation] }, frame.items, {
          now,
        });
        expect(captured.nativeChildDiagnostics).toEqual([]);
        expect(captured.nativeChildren.map((child) => child.childThreadId)).toEqual([
          childThreadId,
        ]);
      }),
    ),
  );
});
