import type { RunnerItem } from "@signalbox/runner-protocol/RunnerProtocol";
import {
  MessageId,
  NodeId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "@effect/vitest";

import { recordedEvents, recordedNativeChildEvents } from "../ThreadRunnerProof.ts";

const parentThreadId = ThreadId.make("thread:parent");
const childThreadId = ThreadId.make("thread:child");
const parentRunId = RunId.make("run:parent:1");
const childMessageId = MessageId.make("message:child:answer");

describe("Runner provider events", () => {
  it("keeps a provider-native child's transcript on the child's thread", () => {
    const projection = {
      thread: { id: parentThreadId, providerInstanceId: ProviderInstanceId.make("codex") },
      runs: [{ id: parentRunId, providerInstanceId: ProviderInstanceId.make("codex") }],
    } as unknown as OrchestrationV2ThreadProjection;
    const item: RunnerItem = {
      kind: "provider",
      runId: parentRunId,
      event: {
        type: "message.updated",
        driver: "codex",
        message: {
          createdBy: "agent",
          creationSource: "provider",
          id: childMessageId,
          threadId: childThreadId,
          runId: null,
          nodeId: NodeId.make("node:child:root"),
          role: "assistant",
          text: "Native child history",
          attachments: [],
          streaming: false,
          createdAt: "2026-10-17T10:00:00.000Z",
          updatedAt: "2026-10-17T10:00:00.000Z",
        },
      },
    };

    const ctx = { now: DateTime.makeUnsafe("2026-10-17T10:00:00.000Z") };
    expect(recordedEvents(projection, item, parentRunId, ctx)).toEqual([]);
    const childProjection = {
      thread: { id: childThreadId, providerInstanceId: ProviderInstanceId.make("codex") },
      runs: [],
    } as unknown as OrchestrationV2ThreadProjection;
    const recorded = recordedNativeChildEvents(childProjection, item, ctx);

    expect(recorded).not.toBe("undecodable");
    if (recorded === "undecodable") throw new Error("valid child message was undecodable");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      type: "message.updated",
      threadId: childThreadId,
      payload: { id: childMessageId, threadId: childThreadId, text: "Native child history" },
    });
    expect(recorded[0]).not.toHaveProperty("runId");
    expect(recorded[0]?.payload).toHaveProperty("runId", null);
  });
});
