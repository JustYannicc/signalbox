// @effect-diagnostics nodeBuiltinImport:off - the eviction tests need a database file that outlives one engine.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadStreamItem,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { layerThreadObject } from "../testing.ts";
import { scriptedModelSelection, scriptedReply } from "./scriptedProvider.ts";
import { applyEvents } from "./threadProjection.ts";
import * as ThreadEngine from "./ThreadEngine.ts";
import * as ThreadStore from "./ThreadStore.ts";

const owner = { userId: "user_1" };
const stranger = { userId: "user_2" };
const personal = { contextId: PERSONAL_CONTEXT_ID };
const threadId = ThreadId.make("thread-1");

const directories: Array<string> = [];
afterEach(() => {
  for (const directory of directories.splice(0)) NodeFS.rmSync(directory, { recursive: true });
});

/** A fresh database file; each `withObject` on it is the object waking up again. */
const freshDatabase = () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "thread-object-"));
  directories.push(directory);
  return NodePath.join(directory, "thread.sqlite");
};

const withObject = <A, E>(
  filename: string,
  use: (
    engine: ThreadEngine.ThreadEngine["Service"],
    store: ThreadStore.ThreadStore["Service"],
  ) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Layer.build(layerThreadObject(filename)).pipe(
      Effect.flatMap((context) =>
        use(
          Context.get(context, ThreadEngine.ThreadEngine),
          Context.get(context, ThreadStore.ThreadStore),
        ),
      ),
    ),
  );

const launch = (engine: ThreadEngine.ThreadEngine["Service"], text = "Hello cloud") =>
  engine.launch(
    owner,
    {
      commandId: CommandId.make("launch-1"),
      threadId,
      projectId: ProjectId.make("scratch"),
      title: "Hello cloud",
      modelSelection: scriptedModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { messageId: MessageId.make("message-1"), text, attachments: [] },
    },
    personal,
  );

const send = (commandId: string, text: string): OrchestrationV2Command => ({
  type: "message.dispatch",
  commandId: CommandId.make(commandId),
  createdBy: "user",
  creationSource: "web",
  threadId,
  messageId: MessageId.make(`message-${commandId}`),
  text,
  attachments: [],
  dispatchMode: { type: "start_immediately" },
  deliveryIntent: "auto",
});

const runToIdle = (engine: ThreadEngine.ThreadEngine["Service"]) =>
  Effect.gen(function* () {
    for (let steps = 0; steps < 200; steps++) {
      if (!(yield* engine.step)) return steps;
    }
    throw new Error("the scripted turn never settled");
  });

const assistantTexts = (engine: ThreadEngine.ThreadEngine["Service"]) =>
  Effect.map(engine.snapshot(owner), ({ projection }) =>
    projection.messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.text),
  );

/** Every event after `cursor`, the way a resuming client asks for them. */
const replayFrom = (engine: ThreadEngine.ThreadEngine["Service"], afterSequence: number) =>
  Effect.scoped(
    Effect.flatMap(
      engine.subscribe(owner, { threadId, afterSequence, requestCompletionMarker: true }),
      (stream) =>
        stream.pipe(
          Stream.flattenIterable,
          Stream.takeUntil((item) => item.kind === "synchronized"),
          Stream.runCollect,
        ),
    ),
  );

describe("ThreadEngine", () => {
  it.effect("launches a thread whose scripted reply streams in chunks and completes", () =>
    withObject(freshDatabase(), (engine) =>
      Effect.gen(function* () {
        const launched = yield* launch(engine);
        expect(launched.resumed).toBe(false);
        expect(launched.projection.runs.map((run) => run.status)).toEqual(["starting"]);

        const steps = yield* runToIdle(engine);
        expect(steps).toBeGreaterThan(3);
        expect(yield* assistantTexts(engine)).toEqual([scriptedReply("Hello cloud")]);

        const { projection } = yield* engine.snapshot(owner);
        expect(projection.runs.map((run) => run.status)).toEqual(["completed"]);
        expect(projection.visibleTurnItems.map((row) => row.item.type)).toEqual([
          "user_message",
          "assistant_message",
        ]);
        const summary = yield* engine.summary(owner);
        expect(summary?.shell.status).toBe("completed");
        expect(summary?.shell.latestUserMessageAt).not.toBeNull();
      }),
    ),
  );

  it.effect("returns the original result for a command id it has already decided", () =>
    withObject(freshDatabase(), (engine) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const relaunched = yield* launch(engine);
        expect(relaunched.resumed).toBe(true);
        yield* runToIdle(engine);

        const first = yield* engine.dispatch(owner, send("send-2", "Again"), personal);
        const retried = yield* engine.dispatch(owner, send("send-2", "Again"), personal);
        expect(retried).toEqual(first);
        yield* runToIdle(engine);

        const { projection } = yield* engine.snapshot(owner);
        expect(projection.runs).toHaveLength(2);
        expect(projection.messages.filter((message) => message.role === "user")).toHaveLength(2);
      }),
    ),
  );

  it.effect("remembers a rejection instead of deciding the command again", () =>
    withObject(freshDatabase(), (engine) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const deferred: OrchestrationV2Command = {
          ...send("deferred", "Later"),
          dispatchMode: { type: "defer_start" },
        } as OrchestrationV2Command;
        const first = yield* Effect.flip(engine.dispatch(owner, deferred, personal));
        const second = yield* Effect.flip(engine.dispatch(owner, deferred, personal));
        expect(first._tag).toBe("ThreadCommandRejectedError");
        expect(second).toEqual(first);
      }),
    ),
  );

  it.effect("finishes a turn interrupted by eviction, and replays from any cursor", () =>
    Effect.gen(function* () {
      const filename = freshDatabase();
      // Evicted partway through streaming the reply.
      yield* withObject(filename, (engine) =>
        Effect.gen(function* () {
          yield* launch(engine);
          for (let step = 0; step < 3; step++) yield* engine.step;
        }),
      );
      const log = yield* withObject(filename, (engine) =>
        Effect.gen(function* () {
          expect(yield* engine.hasTurnWork).toBe(true);
          yield* runToIdle(engine);
          expect(yield* assistantTexts(engine)).toEqual([scriptedReply("Hello cloud")]);
          return yield* replayFrom(engine, 0);
        }),
      );
      // From zero the thread's creation is in range, so the client gets a snapshot.
      expect(log.map((item) => item.kind)).toEqual(["snapshot", "synchronized"]);
      const head = log[0]?.kind === "snapshot" ? log[0].snapshotSequence : 0;

      yield* withObject(filename, (engine, store) =>
        Effect.gen(function* () {
          const { projection } = yield* engine.snapshot(owner);
          for (let cursor = 1; cursor <= head; cursor++) {
            const replay = yield* replayFrom(engine, cursor);
            const events = replay.flatMap((item) => (item.kind === "event" ? [item] : []));
            // Nothing lost, nothing repeated: exactly the events after the cursor, in order.
            expect(events.map((item) => item.sequence)).toEqual(
              Array.from({ length: head - cursor }, (_, index) => cursor + index + 1),
            );
            expect(replay.at(-1)?.kind).toBe("synchronized");
          }
          // What a client held at any cursor, plus the replay after it, is the object's projection.
          const all = (yield* store.events(0)).map((stored) => stored.event);
          for (let cursor = 1; cursor <= head; cursor++) {
            const replay = yield* replayFrom(engine, cursor);
            const tail = replay.flatMap((item) => (item.kind === "event" ? [item.event] : []));
            expect(applyEvents(null, [...all.slice(0, cursor), ...tail])).toEqual(projection);
          }
        }),
      );
    }),
  );

  it.effect("streams each commit to subscribers as one batch after the catch-up", () =>
    withObject(freshDatabase(), (engine) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const { snapshotSequence } = yield* engine.snapshot(owner);
        const received = yield* Effect.scoped(
          Effect.gen(function* () {
            const stream = yield* engine.subscribe(owner, {
              threadId,
              afterSequence: snapshotSequence,
              requestCompletionMarker: true,
            });
            const collecting = yield* stream.pipe(
              Stream.take(3),
              Stream.runCollect,
              Effect.forkChild,
            );
            yield* Effect.yieldNow;
            yield* engine.step;
            yield* engine.step;
            return yield* Fiber.join(collecting);
          }),
        );
        const [marker, starting, chunk] = received as ReadonlyArray<
          ReadonlyArray<OrchestrationV2ThreadStreamItem>
        >;
        expect(marker?.map((item) => item.kind)).toEqual(["synchronized"]);
        // The first step starts the run and streams the first chunk in one commit.
        expect(
          starting?.map((item) => (item.kind === "event" ? item.event.type : item.kind)),
        ).toEqual(["run.updated", "run-attempt.updated", "node.updated", "turn-item.updated"]);
        expect(chunk?.map((item) => (item.kind === "event" ? item.sequence : -1))).toEqual([
          snapshotSequence + 5,
        ]);
      }),
    ),
  );

  it.effect("queues a message sent mid-turn and starts it when the turn completes", () =>
    withObject(freshDatabase(), (engine) =>
      Effect.gen(function* () {
        yield* launch(engine);
        yield* engine.step;
        yield* engine.dispatch(owner, send("send-2", "Second"), personal);
        const queued = yield* engine.snapshot(owner);
        expect(queued.projection.runs.map((run) => run.status)).toEqual(["running", "queued"]);

        yield* runToIdle(engine);
        expect(yield* assistantTexts(engine)).toEqual([
          scriptedReply("Hello cloud"),
          scriptedReply("Second"),
        ]);
      }),
    ),
  );

  it.effect("stops a turn, holds the queue, and resumes it on request", () =>
    withObject(freshDatabase(), (engine) =>
      Effect.gen(function* () {
        const launched = yield* launch(engine);
        yield* engine.step;
        yield* engine.dispatch(owner, send("send-2", "Second"), personal);
        yield* engine.dispatch(
          owner,
          {
            type: "run.interrupt",
            commandId: CommandId.make("stop"),
            threadId,
            runId: launched.projection.runs[0]!.id,
            holdQueue: true,
          },
          personal,
        );
        expect(yield* engine.hasTurnWork).toBe(false);
        const stopped = yield* engine.snapshot(owner);
        expect(stopped.projection.runs.map((run) => [run.status, run.queueHeld === true])).toEqual([
          ["interrupted", false],
          ["queued", true],
        ]);

        yield* engine.dispatch(
          owner,
          {
            type: "queue.resume",
            commandId: CommandId.make("resume"),
            threadId,
          },
          personal,
        );
        yield* runToIdle(engine);
        const resumed = yield* engine.snapshot(owner);
        expect(resumed.projection.runs.map((run) => run.status)).toEqual([
          "interrupted",
          "completed",
        ]);
      }),
    ),
  );

  it.effect("hides a thread from anyone but its owner", () =>
    withObject(freshDatabase(), (engine) =>
      Effect.gen(function* () {
        yield* launch(engine);
        expect((yield* Effect.flip(engine.snapshot(stranger)))._tag).toBe("ThreadNotFoundError");
        expect(
          (yield* Effect.flip(engine.dispatch(stranger, send("x", "hi"), personal)))._tag,
        ).toBe("ThreadNotFoundError");
      }),
    ),
  );

  it.effect("records a new summary revision only when the sidebar row changes", () =>
    withObject(freshDatabase(), (engine) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const launched = (yield* engine.pendingSummary)?.summary;
        expect(launched?.shell.status).toBe("starting");
        yield* engine.acknowledgeSummary(launched!.revision);
        expect(yield* engine.pendingSummary).toBeNull();

        yield* engine.step; // starting -> running changes the row
        const running = (yield* engine.pendingSummary)?.summary;
        expect(running?.shell.status).toBe("running");
        yield* engine.acknowledgeSummary(running!.revision);
        yield* engine.step; // a streamed chunk does not
        expect(yield* engine.pendingSummary).toBeNull();
      }),
    ),
  );

  it.effect("leaves no storage behind for an id that was never created", () =>
    withObject(freshDatabase(), (engine, store) =>
      Effect.gen(function* () {
        expect((yield* Effect.flip(engine.snapshot(owner)))._tag).toBe("ThreadNotFoundError");
        expect((yield* Effect.flip(engine.dispatch(owner, send("x", "hi"), personal)))._tag).toBe(
          "ThreadNotFoundError",
        );
        expect(yield* engine.pendingSummary).toBeNull();
        expect(yield* store.initialized).toBe(false);
      }),
    ),
  );

  it.effect("keeps the reason a create was rejected", () =>
    withObject(freshDatabase(), (engine) =>
      Effect.gen(function* () {
        const rejected = yield* Effect.flip(
          engine.dispatch(
            owner,
            {
              type: "thread.create",
              commandId: CommandId.make("import"),
              createdBy: "user",
              creationSource: "web",
              threadId,
              projectId: ProjectId.make("scratch"),
              title: "Imported",
              modelSelection: scriptedModelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              importedNativeThread: {
                ref: {
                  driver: ProviderDriverKind.make("codex"),
                  nativeId: "native-1",
                  strength: "strong",
                },
              },
            },
            personal,
          ),
        );
        expect(rejected._tag).toBe("ThreadCommandRejectedError");
      }),
    ),
  );
});
