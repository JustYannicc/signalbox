import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointId,
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  ThreadId,
  ProviderDriverKind,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import type { ProviderAdapterV2ThreadSnapshot } from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import {
  collectClaudeSnapshotEvent,
  makeClaudeThreadSnapshots,
  readClaudeThreadSnapshot,
  rememberClaudeSnapshotThread,
  rollbackClaudeThreadSnapshots,
} from "@signalbox/provider-claude/ClaudeThreadSnapshots";

const driver = ProviderDriverKind.make("claudeAgent");
const now = DateTime.makeUnsafe(0);
const identity = {
  providerSessionId: ProviderSessionId.make("session"),
  providerInstanceId: ProviderInstanceId.make("claude-instance"),
};
const thread: OrchestrationV2ProviderThread = {
  id: ProviderThreadId.make("provider-thread"),
  driver,
  ...identity,
  appThreadId: ThreadId.make("app-thread"),
  nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
  nativeConversationHeadRef: null,
  ownerNodeId: null,
  status: "idle",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  pendingBackgroundTasks: [],
  contextUsage: null,
  nativeMetadata: null,
  goal: null,
  createdAt: now,
  updatedAt: now,
};
const turn: OrchestrationV2ProviderTurn = {
  id: ProviderTurnId.make("turn"),
  providerThreadId: thread.id,
  nodeId: NodeId.make("root-node"),
  runAttemptId: null,
  nativeTurnRef: { driver, nativeId: "native-turn", strength: "strong" },
  ordinal: 1,
  status: "completed",
  startedAt: now,
  completedAt: now,
};
const message: OrchestrationV2ConversationMessage = {
  id: MessageId.make("message"),
  threadId: ThreadId.make("app-thread"),
  nodeId: NodeId.make("message-node"),
  runId: null,
  role: "assistant",
  text: "First answer",
  attachments: [],
  streaming: false,
  createdBy: "agent",
  creationSource: "provider",
  createdAt: now,
  updatedAt: now,
};
const request: OrchestrationV2RuntimeRequest = {
  id: RuntimeRequestId.make("request"),
  nodeId: NodeId.make("request-node"),
  providerTurnId: turn.id,
  nativeRequestRef: { driver, nativeId: "native-request", strength: "strong" },
  kind: "command",
  status: "resolved",
  responseCapability: { type: "live", providerSessionId: identity.providerSessionId },
  createdAt: now,
  resolvedAt: now,
};
const checkpoint: ProviderAdapterV2ThreadSnapshot = {
  providerThread: thread,
  providerTurns: [turn],
  messages: [message],
  runtimeRequests: [request],
  providerPayload: { checkpoint: "preserved" },
};

const created = () =>
  Result.getOrThrow(
    rememberClaudeSnapshotThread(
      Result.getOrThrow(makeClaudeThreadSnapshots(identity)),
      thread,
      "created",
    ),
  );

describe("Claude normalized snapshots", () => {
  it("upserts exact rows and keeps a terminal snapshot tied to completed normalized updates", () => {
    let state = created();
    state = collectClaudeSnapshotEvent(state, {
      type: "provider_turn.updated",
      driver,
      providerTurn: { ...turn, status: "running", completedAt: null },
    });
    const partial = { ...message, streaming: true, text: "Fir" };
    state = collectClaudeSnapshotEvent(state, {
      type: "message.updated",
      driver,
      message: partial,
    });
    state = collectClaudeSnapshotEvent(state, {
      type: "turn.terminal",
      driver,
      providerThreadId: thread.id,
      providerTurnId: turn.id,
      runOrdinal: 1,
      status: "completed",
      failure: null,
      threadDisposition: "reusable",
    });
    assert.deepEqual(Result.getOrThrow(readClaudeThreadSnapshot(state, thread)).messages, [
      partial,
    ]);
    state = collectClaudeSnapshotEvent(state, { type: "message.updated", driver, message });
    state = collectClaudeSnapshotEvent(state, {
      type: "provider_turn.updated",
      driver,
      providerTurn: turn,
    });
    const updated = {
      ...thread,
      status: "idle" as const,
      nativeConversationHeadRef: turn.nativeTurnRef,
    };
    state = collectClaudeSnapshotEvent(state, {
      type: "provider_thread.updated",
      driver,
      providerThread: updated,
    });
    assert.deepEqual(Result.getOrThrow(readClaudeThreadSnapshot(state, thread)), {
      providerThread: updated,
      providerTurns: [turn],
      messages: [message],
      runtimeRequests: [],
    });
  });

  it("ignores rows belonging to other threads and provider sessions", () => {
    const state = created();
    let next = collectClaudeSnapshotEvent(state, {
      type: "provider_thread.updated",
      driver,
      providerThread: { ...thread, providerSessionId: ProviderSessionId.make("other-session") },
    });
    next = collectClaudeSnapshotEvent(next, {
      type: "provider_turn.updated",
      driver,
      providerTurn: { ...turn, providerThreadId: ProviderThreadId.make("other-thread") },
    });
    next = collectClaudeSnapshotEvent(next, {
      type: "message.updated",
      driver,
      message: { ...message, threadId: ThreadId.make("other-app-thread") },
    });
    next = collectClaudeSnapshotEvent(next, {
      type: "runtime_request.updated",
      driver,
      runtimeRequest: {
        ...request,
        responseCapability: {
          type: "live",
          providerSessionId: ProviderSessionId.make("other-session"),
        },
      },
    });
    assert.strictEqual(next, state);
  });

  it("merges a full resume checkpoint without dropping prior turns, messages or requests", () => {
    let state = Result.getOrThrow(makeClaudeThreadSnapshots(identity, checkpoint));
    const resumed = { ...thread, updatedAt: DateTime.makeUnsafe(1) };
    state = Result.getOrThrow(rememberClaudeSnapshotThread(state, resumed, "resumed"));
    const nextTurn = { ...turn, id: ProviderTurnId.make("next-turn"), ordinal: 2 };
    const nextMessage = { ...message, id: MessageId.make("next-message"), text: "Second answer" };
    state = collectClaudeSnapshotEvent(state, {
      type: "provider_turn.updated",
      driver,
      providerTurn: nextTurn,
    });
    state = collectClaudeSnapshotEvent(state, {
      type: "message.updated",
      driver,
      message: nextMessage,
    });
    const snapshot = Result.getOrThrow(readClaudeThreadSnapshot(state, resumed));
    assert.deepEqual(snapshot, {
      ...checkpoint,
      providerThread: resumed,
      providerTurns: [turn, nextTurn],
      messages: [message, nextMessage],
    });
    assert.deepEqual(checkpoint.messages, [message]);
  });

  it("rejects a checkpoint or read with mismatched session, application thread, native ref or child rows", () => {
    for (const providerThread of [
      { ...thread, providerSessionId: ProviderSessionId.make("other-session") },
      {
        ...thread,
        nativeThreadRef: {
          driver: ProviderDriverKind.make("codex"),
          nativeId: "native-thread",
          strength: "strong" as const,
        },
      },
    ])
      assert.isTrue(
        Result.isFailure(makeClaudeThreadSnapshots(identity, { ...checkpoint, providerThread })),
      );
    assert.isTrue(
      Result.isFailure(
        makeClaudeThreadSnapshots(identity, {
          ...checkpoint,
          providerTurns: [{ ...turn, providerThreadId: ProviderThreadId.make("other") }],
        }),
      ),
    );
    assert.isTrue(
      Result.isFailure(
        makeClaudeThreadSnapshots(identity, {
          ...checkpoint,
          messages: [{ ...message, threadId: ThreadId.make("other") }],
        }),
      ),
    );
    assert.isTrue(
      Result.isFailure(
        makeClaudeThreadSnapshots(
          { ...identity, threadId: ThreadId.make("other-open-thread") },
          checkpoint,
        ),
      ),
    );
    assert.isTrue(
      Result.isFailure(
        makeClaudeThreadSnapshots(
          { ...identity, initialNativeThreadId: "other-open-native-thread" },
          checkpoint,
        ),
      ),
    );
    const state = Result.getOrThrow(makeClaudeThreadSnapshots(identity, checkpoint));
    for (const changed of [
      { ...thread, appThreadId: ThreadId.make("other-app-thread") },
      {
        ...thread,
        nativeThreadRef: { driver, nativeId: "other-native-thread", strength: "strong" as const },
      },
    ]) {
      assert.isTrue(Result.isFailure(rememberClaudeSnapshotThread(state, changed, "resumed")));
      assert.isTrue(Result.isFailure(readClaudeThreadSnapshot(state, changed)));
    }
  });

  it("does not claim an empty transcript for a native resume without its checkpoint", () => {
    const state = Result.getOrThrow(
      rememberClaudeSnapshotThread(
        Result.getOrThrow(makeClaudeThreadSnapshots(identity)),
        thread,
        "resumed",
      ),
    );
    const snapshot = readClaudeThreadSnapshot(state, thread);
    assert.isTrue(Result.isFailure(snapshot));
    if (Result.isFailure(snapshot)) assert.equal(snapshot.failure.reason, "history-unavailable");
    assert.deepEqual(Result.getOrThrow(readClaudeThreadSnapshot(created(), thread)).messages, []);
  });

  it("keeps a pending request pending until the normalized response arrives", () => {
    let state = Result.getOrThrow(makeClaudeThreadSnapshots(identity, checkpoint));
    const pending = { ...request, status: "pending" as const, resolvedAt: null };
    state = collectClaudeSnapshotEvent(state, {
      type: "runtime_request.updated",
      driver,
      runtimeRequest: pending,
    });
    assert.deepEqual(Result.getOrThrow(readClaudeThreadSnapshot(state, thread)).runtimeRequests, [
      pending,
    ]);
    state = collectClaudeSnapshotEvent(state, {
      type: "runtime_request.updated",
      driver,
      runtimeRequest: request,
    });
    assert.deepEqual(Result.getOrThrow(readClaudeThreadSnapshot(state, thread)).runtimeRequests, [
      request,
    ]);
  });
});

const rollbackTarget = {
  type: "provider_turn" as const,
  checkpointId: CheckpointId.make("first-turn"),
  appRunOrdinal: 1,
  providerTurn: turn,
};
const rewoundThread = {
  ...thread,
  nativeConversationHeadRef: turn.nativeTurnRef,
  lastRunOrdinal: 1,
};
const secondTurn = {
  ...turn,
  id: ProviderTurnId.make("second-turn"),
  ordinal: 2,
  nodeId: NodeId.make("second-root"),
  nativeTurnRef: { driver, nativeId: "second-native-turn", strength: "strong" as const },
};
const secondMessage = {
  ...message,
  id: MessageId.make("second-message"),
  nodeId: NodeId.make("second-message-node"),
  text: "Discarded answer",
};
const secondRequest = {
  ...request,
  id: RuntimeRequestId.make("second-request"),
  nodeId: NodeId.make("second-request-node"),
  providerTurnId: secondTurn.id,
};

function observedTwoTurns() {
  let state = Result.getOrThrow(makeClaudeThreadSnapshots(identity, checkpoint));
  for (const providerTurn of [turn, secondTurn]) {
    state = collectClaudeSnapshotEvent(state, {
      type: "provider_turn.updated",
      driver,
      providerTurn,
    });
  }
  for (const [row, providerTurn] of [
    [message, turn],
    [secondMessage, secondTurn],
  ] as const) {
    const nodeId = row.nodeId;
    assert.isNotNull(nodeId);
    state = collectClaudeSnapshotEvent(state, {
      type: "node.updated",
      driver,
      node: {
        id: nodeId,
        threadId: row.threadId,
        runId: null,
        parentNodeId: providerTurn.nodeId,
        rootNodeId: providerTurn.nodeId,
        kind: "assistant_message",
        status: "completed",
        countsForRun: false,
        providerThreadId: thread.id,
        providerTurnId: providerTurn.id,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: now,
      },
    });
    state = collectClaudeSnapshotEvent(state, { type: "message.updated", driver, message: row });
  }
  return collectClaudeSnapshotEvent(state, {
    type: "runtime_request.updated",
    driver,
    runtimeRequest: secondRequest,
  });
}

describe("Claude snapshot rollback", () => {
  it.each([false, true])(
    "trims exact observed rows and request ownership, including after checkpoint reload (%j)",
    (seeded) => {
      let state = observedTwoTurns();
      const full = Result.getOrThrow(readClaudeThreadSnapshot(state, thread));
      if (seeded) state = Result.getOrThrow(makeClaudeThreadSnapshots(identity, full));
      state = Result.getOrThrow(
        rollbackClaudeThreadSnapshots(state, thread, rewoundThread, rollbackTarget),
      );
      const snapshot = Result.getOrThrow(readClaudeThreadSnapshot(state, rewoundThread));
      assert.deepEqual(snapshot.providerThread, rewoundThread);
      assert.deepEqual(snapshot.providerTurns, [turn]);
      assert.deepEqual(snapshot.messages, [message]);
      assert.deepEqual(snapshot.runtimeRequests, [request]);
      assert.deepEqual(
        Result.getOrThrow(
          readClaudeThreadSnapshot(
            Result.getOrThrow(makeClaudeThreadSnapshots(identity, snapshot)),
            rewoundThread,
          ),
        ),
        snapshot,
      );
      assert.deepEqual(full.messages, [message, secondMessage]);
    },
  );

  it("registers a reset as a complete empty native thread and retires the old entry", () => {
    const state = observedTwoTurns();
    const reset = {
      ...thread,
      id: ProviderThreadId.make("reset-thread"),
      nativeThreadRef: { driver, nativeId: "reset-native-thread", strength: "strong" as const },
    };
    const next = Result.getOrThrow(
      rollbackClaudeThreadSnapshots(state, thread, reset, {
        type: "thread_start",
        checkpointId: CheckpointId.make("thread-start"),
        appRunOrdinal: 0,
      }),
    );
    assert.deepEqual(Result.getOrThrow(readClaudeThreadSnapshot(next, reset)), {
      providerThread: reset,
      providerTurns: [],
      messages: [],
      runtimeRequests: [],
    });
    assert.isTrue(Result.isFailure(readClaudeThreadSnapshot(next, thread)));
    assert.deepEqual(Result.getOrThrow(readClaudeThreadSnapshot(state, thread)).messages, [
      message,
      secondMessage,
    ]);
  });

  it("invalidates an older checkpoint when message ownership cannot establish the retained boundary", () => {
    const full = {
      ...checkpoint,
      providerTurns: [turn, secondTurn],
      messages: [message, secondMessage],
    };
    const state = Result.getOrThrow(makeClaudeThreadSnapshots(identity, full));
    const next = Result.getOrThrow(
      rollbackClaudeThreadSnapshots(state, thread, rewoundThread, rollbackTarget),
    );
    const snapshot = readClaudeThreadSnapshot(next, rewoundThread);
    assert.isTrue(Result.isFailure(snapshot));
    if (Result.isFailure(snapshot)) assert.equal(snapshot.failure.reason, "history-unavailable");
  });

  it("preserves observed rows when no later turn is discarded from an older checkpoint", () => {
    const state = Result.getOrThrow(makeClaudeThreadSnapshots(identity, checkpoint));
    const next = Result.getOrThrow(
      rollbackClaudeThreadSnapshots(state, thread, rewoundThread, rollbackTarget),
    );
    assert.deepEqual(Result.getOrThrow(readClaudeThreadSnapshot(next, rewoundThread)).messages, [
      message,
    ]);
  });

  it("refuses to claim a boundary for a target whose native cursor was not observed", () => {
    const state = observedTwoTurns();
    const next = Result.getOrThrow(
      rollbackClaudeThreadSnapshots(state, thread, rewoundThread, {
        ...rollbackTarget,
        providerTurn: {
          ...turn,
          nativeTurnRef: { driver, nativeId: "unobserved-cursor", strength: "strong" },
        },
      }),
    );
    assert.isTrue(Result.isFailure(readClaudeThreadSnapshot(next, rewoundThread)));
    assert.isTrue(
      Result.isFailure(
        rollbackClaudeThreadSnapshots(
          state,
          thread,
          { ...rewoundThread, appThreadId: ThreadId.make("other") },
          rollbackTarget,
        ),
      ),
    );
  });
});
