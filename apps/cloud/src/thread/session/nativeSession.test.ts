import {
  type OrchestrationV2ProviderThread,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { holdsNativeSession } from "./nativeSession.ts";
import * as SessionRows from "./SessionRows.ts";

const at = DateTime.makeUnsafe(0);

const providerThread = (
  driver: string,
  nativeId: string | null,
): OrchestrationV2ProviderThread => ({
  id: ProviderThreadId.make("provider-thread-1"),
  driver: ProviderDriverKind.make(driver),
  providerInstanceId: ProviderInstanceId.make(driver),
  providerSessionId: null,
  appThreadId: ThreadId.make("thread-1"),
  ownerNodeId: null,
  nativeThreadRef:
    nativeId === null
      ? null
      : { driver: ProviderDriverKind.make(driver), nativeId, strength: "strong" },
  nativeConversationHeadRef: null,
  firstRunOrdinal: 1,
  lastRunOrdinal: 1,
  handoffIds: [],
  forkedFrom: null,
  status: "idle",
  createdAt: at,
  updatedAt: at,
});

const layer = SessionRows.layer.pipe(
  Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
);

const store = (stream: string) =>
  Effect.gen(function* () {
    const rows = yield* SessionRows.SessionRows;
    yield* rows.append({ stream, offset: 0, rows: ['{"type":"user"}'] });
  });

const holds = (thread: OrchestrationV2ProviderThread) =>
  Effect.gen(function* () {
    return yield* holdsNativeSession(yield* SessionRows.SessionRows, thread);
  });

describe("holdsNativeSession", () => {
  it.effect("finds Claude's transcript by session id, not a sidecar or a longer id", () =>
    Effect.gen(function* () {
      yield* store("claude/session-12");
      yield* store("claude/session-1/subagents/agent-a.jsonl");
      expect(yield* holds(providerThread("claudeAgent", "session-1"))).toBe(false);
      yield* store("claude/session-1");
      expect(yield* holds(providerThread("claudeAgent", "session-1"))).toBe(true);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("finds Codex's rollout by the thread id ending its name", () =>
    Effect.gen(function* () {
      const thread = providerThread("codex", "0199a1b2-c3d4");
      expect(yield* holds(thread)).toBe(false);
      yield* store("codex/2026/10/15/rollout-2026-10-15T10-00-00-0199a1b2-c3d4.jsonl");
      expect(yield* holds(thread)).toBe(true);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("holds nothing without a ref, and trusts a harness the store doesn't keep", () =>
    Effect.gen(function* () {
      expect(yield* holds(providerThread("claudeAgent", null))).toBe(false);
      expect(yield* holds(providerThread("opencode", "anything"))).toBe(true);
    }).pipe(Effect.provide(layer)),
  );
});
