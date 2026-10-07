import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";

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
          CloudRpc.layerHandlers({ identity, actor: { userId } }),
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
      const live = yield* rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
        threadId,
        requestCompletionMarker: true,
      }).pipe(
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
      yield* Effect.yieldNow;
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
          .summary({ userId })
          .pipe(Effect.map((summary) => summary?.contextId));
      expect(yield* contextOf(work)).toBe("org_acme");
      expect(yield* contextOf(threadId)).toBe("personal");

      // Leaving the organization closes its project to new threads, but a
      // thread keeps the context it was created as.
      yield* user.syncOrganizations([]);
      const rejected = yield* launchIn(ThreadId.make("thread-late"), acmeProject).pipe(Effect.flip);
      expect(rejected._tag).toBe("OrchestrationV2ThreadLaunchError");
      expect(yield* contextOf(work)).toBe("org_acme");
      // A retry of the launch that already landed still replays.
      const retried = yield* launchIn(work, acmeProject);
      expect(retried.resumed).toBe(true);
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
});
