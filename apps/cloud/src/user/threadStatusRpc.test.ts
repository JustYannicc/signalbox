import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import {
  SIGNALBOX_THREAD_STATUS_WS_METHODS,
  type SignalboxThreadStatusStreamItem,
  type ThreadStatusNote,
} from "@t3tools/contracts/signalboxStatusLine";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import * as Environment from "../environment.ts";
import { makeMemoryCloud } from "../testing.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import type { ThreadSummary } from "../thread/ThreadEngine.ts";
import { wire } from "../thread/threadWire.ts";
import * as CloudRpc from "./rpc.ts";

/**
 * Status notes reach clients from the user's object (#670): a snapshot of
 * every listed thread's note first, then one small item per changed note,
 * and never a note of a thread in a context the user isn't in.
 */

const identity = { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" };
const userId = "user_1";
const mine = ThreadId.make("thread-mine");
const theirs = ThreadId.make("thread-elsewhere");

const noteAt = (ms: number, nextStep: string): ThreadStatusNote => ({
  nextStep,
  whereItGotTo: "The draft is written.",
  writtenAt: DateTime.makeUnsafe(ms),
  writtenBy: "agent",
  runId: RunId.make("run-1"),
});

const connect = Effect.gen(function* () {
  const cloud = makeMemoryCloud();
  const user = cloud.userDirectory.forUser(userId);
  yield* user.recordSignIn({ id: userId, email: "a@b.c" });
  const rpc = yield* RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
    Effect.provide(
      Layer.mergeAll(
        CloudRpc.layerHandlers({ identity, userId, sid: "test-session" }),
        CloudRpc.layerScopeAuthorization([
          AuthOrchestrationReadScope,
          AuthOrchestrationOperateScope,
        ]),
      ).pipe(Layer.provide(cloud.layerFor(userId))),
    ),
  );
  yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread]({
    commandId: CommandId.make("launch"),
    threadId: mine,
    projectId: Environment.SCRATCH_PROJECT_ID,
    title: "Quarterly report",
    modelSelection: scriptedModelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
    initialMessage: { messageId: MessageId.make("m1"), text: "Draft it", attachments: [] },
  });
  yield* cloud.settle;
  const base = (yield* cloud.threadDirectory.forThread(mine).summary({ userId, contextIds: [] }))!;
  /** What a thread object's outbox delivers: its summary, with a note, one revision on. */
  let revision = base.revision;
  const deliver = (summary: ThreadSummary) =>
    user.recordThreadSummary(wire.summary.encode({ ...summary, revision: ++revision }));
  // A thread of an organization the user isn't in, as their index keeps it.
  const elsewhere: ThreadSummary = {
    ...base,
    threadId: theirs,
    contextId: SignalboxContextId.make("org_left"),
    shell: { ...base.shell, id: theirs },
  };
  return { rpc, base, elsewhere, deliver };
});

describe("thread status notes in the cloud (#670)", () => {
  it.effect("send a snapshot, then one item per changed note, of visible threads only", () =>
    Effect.gen(function* () {
      const { rpc, base, elsewhere, deliver } = yield* connect;
      const first = noteAt(1_000, "You: say whether the draft can go out.");
      yield* deliver({ ...base, statusNote: first });
      yield* deliver({ ...elsewhere, statusNote: noteAt(1_000, "Someone else's.") });

      const items = yield* Queue.unbounded<SignalboxThreadStatusStreamItem>();
      const reader = yield* rpc[SIGNALBOX_THREAD_STATUS_WS_METHODS.subscribe]({}).pipe(
        Stream.runForEach((item) => Queue.offer(items, item)),
        Effect.forkChild,
      );
      expect(yield* Queue.take(items)).toEqual({
        _tag: "snapshot",
        notes: [{ threadId: mine, note: first }],
      });

      // Another context's change stays out; an older note redelivered changes nothing.
      yield* deliver({ ...elsewhere, statusNote: noteAt(2_000, "Still someone else's.") });
      yield* deliver({ ...base, statusNote: noteAt(500, "Stale.") });
      const second = noteAt(3_000, "Agent: send it out.");
      yield* deliver({ ...base, statusNote: second });
      expect(yield* Queue.take(items)).toEqual({ _tag: "note", threadId: mine, note: second });
      expect(yield* Queue.size(items)).toBe(0);
      yield* Fiber.interrupt(reader);
    }).pipe(Effect.scoped),
  );
});
