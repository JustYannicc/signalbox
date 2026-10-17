import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  type AuthEnvironmentScope,
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ThreadId,
  TurnItemId,
  WS_METHODS,
} from "@t3tools/contracts";
import { SIGNALBOX_PERSON_BROWSER_WS_METHODS } from "@t3tools/contracts/signalboxPersonBrowser";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as RpcTest from "effect/rpc/RpcTest";

import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { SIGNALBOX_TRASH_WS_METHODS } from "@t3tools/contracts/signalboxTrash";

import * as Environment from "../environment.ts";
import { makeMemoryCloud } from "../testing.ts";
import { scriptedModelSelection, scriptedReply } from "../thread/scriptedProvider.ts";
import { projectIdForContext } from "./contextProjects.ts";
import * as CloudRpc from "./rpc.ts";

const identity = { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" };
const userId = "user_1";
const threadId = ThreadId.make("thread-1");

/** A socket to `userId`'s object in a fresh in-memory cloud, as the RPC test client. */
const connect = (
  scopes: ReadonlyArray<AuthEnvironmentScope> = [
    AuthOrchestrationReadScope,
    AuthOrchestrationOperateScope,
  ],
) =>
  Effect.gen(function* () {
    const cloud = makeMemoryCloud();
    yield* cloud.userDirectory.forUser(userId).recordSignIn({ id: userId, email: "a@b.c" });
    const rpc = yield* RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
      Effect.provide(
        Layer.mergeAll(
          CloudRpc.layerHandlers({ identity, userId, sid: "test-session" }),
          CloudRpc.layerScopeAuthorization(scopes),
        ).pipe(Layer.provide(cloud.layerFor(userId))),
      ),
    );
    return { cloud, rpc };
  });

const client = (scopes?: ReadonlyArray<AuthEnvironmentScope>) =>
  Effect.map(connect(scopes), ({ rpc }) => rpc);

type Rpc = Effect.Success<ReturnType<typeof client>>;

const launch = (rpc: Rpc, commandId = "launch-1") =>
  rpc[ORCHESTRATION_V2_WS_METHODS.launchThread]({
    commandId: CommandId.make(commandId),
    threadId,
    projectId: Environment.SCRATCH_PROJECT_ID,
    title: "Hello",
    modelSelection: scriptedModelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
    initialMessage: { messageId: MessageId.make("message-1"), text: "Hello", attachments: [] },
  });

const send = (rpc: Rpc, commandId: string, text: string) =>
  rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
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

/** The thread as a client opening it sees it: catch-up through the completion marker. */
const openThread = (rpc: Rpc) =>
  rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
    threadId,
    requestCompletionMarker: true,
  }).pipe(
    Stream.takeUntil((item) => item.kind === "synchronized"),
    Stream.runCollect,
  );

const sidebar = (rpc: Rpc) =>
  rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}).pipe(
    Stream.take(1),
    Stream.runCollect,
    Effect.map(([item]) => (item?.kind === "snapshot" ? item.snapshot : null)),
  );

describe("cloud RPC", () => {
  it.effect.each([
    { archived: false, state: "active" },
    { archived: true, state: "archived" },
  ])("removes a trashed $state thread from live and fresh shells", ({ archived }) =>
    Effect.gen(function* () {
      const { cloud, rpc } = yield* connect();
      yield* launch(rpc);
      yield* cloud.settle;
      if (archived) {
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "thread.archive",
          commandId: CommandId.make("archive-before-trash"),
          threadId,
        });
        yield* cloud.settle;
      }
      const before = yield* sidebar(rpc);
      expect((archived ? before?.archivedThreads : before?.threads)?.map((row) => row.id)).toEqual([
        threadId,
      ]);
      const caughtUp = yield* Deferred.make<void>();
      const live = yield* rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({
        requestCompletionMarker: true,
      }).pipe(
        Stream.tap((item) =>
          item.kind === "synchronized" ? Deferred.succeed(caughtUp, undefined) : Effect.void,
        ),
        Stream.filter((item) => item.kind === "thread.updated" || item.kind === "thread.removed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(caughtUp);
      const trashed = yield* rpc[SIGNALBOX_TRASH_WS_METHODS.thread]({ threadId });
      yield* cloud.settle;
      expect(yield* Fiber.join(live)).toEqual([
        {
          kind: "thread.removed",
          sequence: expect.any(Number),
          location: archived ? "archive" : "active",
          threadId,
        },
      ]);
      const hidden = yield* sidebar(rpc);
      expect(hidden?.threads).toEqual([]);
      expect(hidden?.archivedThreads).toEqual([]);
      const entry = trashed.entries.find((row) => row.targetId === threadId)!;
      yield* rpc[SIGNALBOX_TRASH_WS_METHODS.restore]({ id: entry.id });
      yield* cloud.settle;
      const restored = yield* sidebar(rpc);
      expect(
        (archived ? restored?.archivedThreads : restored?.threads)?.map((row) => row.id),
      ).toEqual([threadId]);
    }).pipe(Effect.scoped),
  );

  it.effect("serves the person's one managed browser profile through the user RPC", () =>
    Effect.gen(function* () {
      const rpc = yield* client([AuthOrchestrationReadScope, AuthPreviewOperateScope]);
      expect(yield* rpc[SIGNALBOX_PERSON_BROWSER_WS_METHODS.profileStatus]({})).toEqual({
        available: false,
      });

      const failure = yield* Effect.flip(rpc[SIGNALBOX_PERSON_BROWSER_WS_METHODS.clearProfile]({}));
      expect(failure).toMatchObject({
        _tag: "SignalboxPersonBrowserError",
        message: "Cloud browser sign-ins could not be cleared. Try again.",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("emits resume transitions and its marker under the requesting trace", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      yield* Effect.gen(function* () {
        const rpc = yield* client();
        yield* launch(rpc);
        const first = yield* openThread(rpc);
        const snapshot = first.find((item) => item.kind === "snapshot");
        if (snapshot?.kind !== "snapshot") throw new Error("Expected the initial snapshot");
        const resumed = yield* rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
          threadId,
          afterSequence: snapshot.snapshotSequence,
          requestCompletionMarker: true,
        }).pipe(
          Stream.takeUntil((item) => item.kind === "synchronized"),
          Stream.runCollect,
        );
        expect(resumed.at(-1)?.kind).toBe("synchronized");
      }).pipe(Effect.withSpan("test.resume"), Effect.provideService(Tracer.Tracer, tracer));
      const transitions = spans.filter((span) => span.name.startsWith("orchestration.sync."));
      expect(transitions.map((span) => span.attributes.get("sync.transition"))).toContain(
        "resuming",
      );
      expect(transitions.map((span) => span.attributes.get("sync.transition"))).toContain(
        "marker_emitted",
      );
      expect(new Set(transitions.map((span) => span.traceId)).size).toBe(1);
      expect(transitions.every((span) => span.status._tag === "Ended")).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("opens the config stream with a snapshot of this environment and holds it open", () =>
    Effect.gen(function* () {
      const rpc = yield* client();
      const [first] = yield* rpc[WS_METHODS.subscribeServerConfig]({}).pipe(
        Stream.take(1),
        Stream.runCollect,
      );
      expect(first?.type).toBe("snapshot");
      if (first?.type !== "snapshot") return;
      expect(first.config.environment.environmentId).toBe("cloud-test");
      expect(first.config.environment.orchestrationProtocolVersion).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("sends the shell snapshot unless the client is already current", () =>
    Effect.gen(function* () {
      const rpc = yield* client();
      const shell = (input: { afterSequence?: number; requestCompletionMarker?: boolean }) =>
        rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell](input).pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.map(([item]) => item?.kind),
        );
      expect(yield* shell({})).toBe("snapshot");
      expect(yield* shell({ afterSequence: 0, requestCompletionMarker: true })).toBe(
        "synchronized",
      );
      // Ahead of the object (a reset one): start over from the snapshot.
      expect(yield* shell({ afterSequence: 7 })).toBe("snapshot");
    }).pipe(Effect.scoped),
  );

  it.effect("welcomes the primary client with nothing to bootstrap", () =>
    Effect.gen(function* () {
      const rpc = yield* client();
      const events = yield* rpc[WS_METHODS.subscribeServerLifecycle]({}).pipe(
        Stream.take(2),
        Stream.runCollect,
      );
      expect(events.map((event) => event.type)).toEqual(["welcome", "ready"]);
    }).pipe(Effect.scoped),
  );

  it.effect("creates a thread whose scripted reply streams and lists it in the sidebar", () =>
    Effect.gen(function* () {
      const { cloud, rpc } = yield* connect();
      const launched = yield* launch(rpc);
      expect(launched.threadId).toBe(threadId);
      yield* cloud.settle;

      const [snapshot, marker] = yield* openThread(rpc);
      expect(marker?.kind).toBe("synchronized");
      if (snapshot?.kind !== "snapshot") throw new Error("expected a snapshot");
      expect(snapshot.projection.messages.map((message) => [message.role, message.text])).toEqual([
        ["user", "Hello"],
        ["assistant", scriptedReply("Hello")],
      ]);

      const shell = yield* sidebar(rpc);
      expect(shell?.projects.map((project) => project.id)).toEqual([
        Environment.SCRATCH_PROJECT_ID,
      ]);
      expect(shell?.threads.map((thread) => [thread.id, thread.status])).toEqual([
        [threadId, "completed"],
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("streams a follow-up's events to an open thread after its catch-up", () =>
    Effect.gen(function* () {
      const { cloud, rpc } = yield* connect();
      yield* launch(rpc);
      yield* cloud.settle;
      const caughtUp = yield* Deferred.make<void>();
      const live = yield* rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
        threadId,
        requestCompletionMarker: true,
      }).pipe(
        Stream.tap((item) =>
          item.kind === "synchronized" ? Deferred.succeed(caughtUp, undefined) : Effect.void,
        ),
        Stream.takeUntil(
          (item) =>
            item.kind === "event" &&
            item.event.type === "run.updated" &&
            item.event.payload.ordinal === 2 &&
            item.event.payload.status === "completed",
        ),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(caughtUp);
      yield* send(rpc, "send-2", "More");
      yield* cloud.settle;
      const items = yield* Fiber.join(live);
      expect(items.map((item) => item.kind).slice(0, 2)).toEqual(["snapshot", "synchronized"]);
      const sequences = items.flatMap((item) => (item.kind === "event" ? [item.sequence] : []));
      expect(sequences).toEqual(sequences.toSorted((left, right) => left - right));
      expect(new Set(sequences).size).toBe(sequences.length);
    }).pipe(Effect.scoped),
  );

  it.effect("starts one turn for a command id however often it is sent", () =>
    Effect.gen(function* () {
      const { cloud, rpc } = yield* connect();
      yield* launch(rpc);
      expect((yield* launch(rpc)).resumed).toBe(true);
      yield* cloud.settle;
      const first = yield* send(rpc, "send-2", "More");
      const again = yield* send(rpc, "send-2", "More");
      expect(again).toEqual(first);
      yield* cloud.settle;

      const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId });
      expect(projection.runs.map((run) => run.status)).toEqual(["completed", "completed"]);
    }).pipe(Effect.scoped),
  );

  it.effect("rebuilds the sidebar index from the thread objects to the same rows", () =>
    Effect.gen(function* () {
      const { cloud, rpc } = yield* connect();
      yield* launch(rpc);
      yield* cloud.settle;
      const before = yield* sidebar(rpc);

      expect(yield* cloud.userDirectory.forUser(userId).rebuildThreadIndex()).toBe(1);
      const after = yield* sidebar(rpc);
      expect(after?.threads).toEqual(before?.threads);
      expect(after?.snapshotSequence).toBeGreaterThan(before?.snapshotSequence ?? 0);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects threads in a project the user does not have", () =>
    Effect.gen(function* () {
      const rpc = yield* client();
      const failure = yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread]({
        commandId: CommandId.make("launch-x"),
        threadId,
        projectId: ProjectId.make("someone-elses"),
        title: "Hello",
        modelSelection: scriptedModelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
      }).pipe(Effect.flip);
      expect(failure._tag).toBe("OrchestrationV2ThreadLaunchError");
    }).pipe(Effect.scoped),
  );

  it.effect("records the context each new thread acts as, from the project it starts in", () =>
    Effect.gen(function* () {
      const { cloud, rpc } = yield* connect();
      const user = cloud.userDirectory.forUser(userId);
      yield* user.syncOrganizations([{ id: "org_acme", name: "Acme" }]);
      const acmeProject = projectIdForContext(SignalboxContextId.make("org_acme"));
      const shell = yield* sidebar(rpc);
      expect(shell?.projects.map((project) => [project.id, project.title])).toEqual([
        [Environment.SCRATCH_PROJECT_ID, "Scratch"],
        [acmeProject, "Acme"],
      ]);

      const launchIn = (id: ThreadId, projectId: ProjectId) =>
        rpc[ORCHESTRATION_V2_WS_METHODS.launchThread]({
          commandId: CommandId.make(`launch-${id}`),
          threadId: id,
          projectId,
          title: "Hello",
          modelSelection: scriptedModelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
        });
      const work = ThreadId.make("thread-work");
      yield* launchIn(work, acmeProject);
      yield* launchIn(threadId, Environment.SCRATCH_PROJECT_ID);
      const contextOf = (id: ThreadId) =>
        cloud.threadDirectory
          .forThread(id)
          .summary({ userId, contextIds: [] })
          .pipe(Effect.map((summary) => summary?.contextId));
      expect(yield* contextOf(work)).toBe("org_acme");
      expect(yield* contextOf(threadId)).toBe("personal");

      // Leaving the organization closes its project to new threads and hides
      // its threads, which keep the context they were created as.
      yield* user.syncOrganizations([]);
      const rejected = yield* launchIn(ThreadId.make("thread-late"), acmeProject).pipe(Effect.flip);
      expect(rejected._tag).toBe("OrchestrationV2ThreadLaunchError");
      expect(yield* contextOf(work)).toBe("org_acme");
      const retried = yield* launchIn(work, acmeProject).pipe(Effect.flip);
      expect(retried.message).toBe("Thread not found.");
    }).pipe(Effect.scoped),
  );

  it.effect("sends an open sidebar the new projects when the user's organizations change", () =>
    Effect.gen(function* () {
      const { cloud, rpc } = yield* connect();
      const subscribed = yield* Deferred.make<void>();
      const projectsSeen = yield* rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}).pipe(
        Stream.tap(() => Deferred.succeed(subscribed, undefined)),
        Stream.filter((item) => item.kind === "snapshot"),
        Stream.map((item) => (item.kind === "snapshot" ? item.snapshot.projects.length : 0)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(subscribed);
      // Sections alone don't touch the sidebar's projects.
      yield* rpc[WS_METHODS.sectionsCreate]({
        name: "Inbox",
        parentId: null,
        contextId: "personal",
      });
      yield* cloud.userDirectory
        .forUser(userId)
        .syncOrganizations([{ id: "org_acme", name: "Acme" }]);
      expect(yield* Fiber.join(projectsSeen)).toEqual([1, 2]);
    }).pipe(Effect.scoped),
  );

  it.effect("authorizes every RPC against the connection's scopes", () =>
    Effect.gen(function* () {
      const rpc = yield* client([]);
      const denied = yield* rpc[WS_METHODS.serverProbe]({}).pipe(Effect.flip);
      expect(denied).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredScope: AuthOrchestrationReadScope,
      });
      const readOnly = yield* client([AuthOrchestrationReadScope]);
      const send = yield* launch(readOnly).pipe(Effect.flip);
      expect(send).toMatchObject({ requiredScope: AuthOrchestrationOperateScope });
    }).pipe(Effect.scoped),
  );

  it.effect("serves URLs for tool output images in the user's threads, and nothing else", () =>
    Effect.gen(function* () {
      const rpc = yield* client();
      yield* launch(rpc);
      const image = { _tag: "tool-output-image", threadId, index: 0 } as const;
      const missing = yield* rpc[WS_METHODS.assetsCreateUrl]({
        resource: { ...image, itemId: TurnItemId.make("item-without-images") },
      }).pipe(Effect.flip);
      expect(missing._tag).toBe("AssetWorkspaceAssetNotFoundError");
      const file = yield* rpc[WS_METHODS.assetsCreateUrl]({
        resource: { _tag: "workspace-file", threadId, path: "README.md" },
      }).pipe(Effect.flip);
      expect(file._tag).toBe("AssetWorkspaceContextNotFoundError");
      const unscoped = yield* client([]);
      const denied = yield* unscoped[WS_METHODS.assetsCreateUrl]({
        resource: { ...image, itemId: TurnItemId.make("item") },
      }).pipe(Effect.flip);
      expect(denied).toMatchObject({ requiredScope: AuthOrchestrationReadScope });
    }).pipe(Effect.scoped),
  );
});
