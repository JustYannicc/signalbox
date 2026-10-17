import {
  RuntimeRequestId,
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AuthSessionState,
  type OrchestrationV2Command,
  type OrchestrationV2DispatchCommandResult,
  type OrchestrationV2ShellSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { vi } from "vite-plus/test";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createThreadEnvironmentAtoms } from "./threadCommands.ts";

export const testConfigAtoms = Atom.family((_id: EnvironmentId) =>
  Atom.make({
    environment: {
      capabilities: { signalboxCloud: false, threadPinning: true, threadPinReorder: true },
    },
  }),
);
export const testSessionAtoms = Atom.family((_id: EnvironmentId) =>
  Atom.make<AuthSessionState | null>({
    authenticated: true,
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: [],
      sessionMethods: [],
      sessionCookieName: "test",
    },
    scopes: [AuthOrchestrationOperateScope],
    permissions: [AuthOrchestrationOperateScope],
  }),
);
const sessionResults = Atom.family((id: EnvironmentId) =>
  Atom.make((get) => {
    const session = get(testSessionAtoms(id));
    return session === null
      ? AsyncResult.initial<AuthSessionState, never>()
      : AsyncResult.success(session);
  }),
);
vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({
    initialConfigValueAtom: testConfigAtoms,
    sessionStateValueAtom: testSessionAtoms,
    sessionStateAtom: sessionResults,
  }),
}));

export const ENVIRONMENT_ID = EnvironmentId.make("remote");
export const THREAD_ID = ThreadId.make("thread");
export const NOW = DateTime.makeUnsafe("2026-09-12T10:00:00.000Z");
export const FUTURE = DateTime.makeUnsafe("2099-01-01T00:00:00.000Z");
export const APPROVAL = {
  id: RuntimeRequestId.make("approval"),
  kind: "command" as const,
  createdAt: NOW,
};
export const USER_INPUT = {
  id: RuntimeRequestId.make("input"),
  kind: "user_input" as const,
  createdAt: NOW,
};
export const SNAPSHOT: OrchestrationV2ShellSnapshot = {
  snapshotSequence: 1,
  schemaVersion: 2,
  archivedThreads: [],
  projects: [],
  threads: [
    {
      id: THREAD_ID,
      projectId: ProjectId.make("project"),
      title: "Remote thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: ProviderInstanceId.make("codex"),
      lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      activeProviderThreadId: null,
      latestRunId: null,
      activeRunId: null,
      status: "idle",
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      itemCount: 0,
      visibleItemCount: 0,
      deletedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      pullRequests: [],
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
    },
  ],
};

export const makeHarness = Effect.fn("TestThreadCommands.makeHarness")(function* () {
  const requests = yield* Queue.unbounded<{
    command: OrchestrationV2Command;
    reply: Deferred.Deferred<OrchestrationV2DispatchCommandResult, Error>;
  }>();
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: { environmentId: ENVIRONMENT_ID },
    session: yield* SubscriptionRef.make(
      Option.some({
        client: {
          [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
            Effect.gen(function* () {
              const reply = yield* Deferred.make<OrchestrationV2DispatchCommandResult, Error>();
              yield* Queue.offer(requests, { command, reply });
              return yield* Deferred.await(reply);
            }),
        },
      } as unknown as RpcSession),
    ),
  } as EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
        run: (_environmentId, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
      Layer.succeed(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size),
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
      ),
    ),
  );
  const snapshotAtom = Atom.family((_environmentId: EnvironmentId) => Atom.make(SNAPSHOT));
  const commands = createThreadEnvironmentAtoms(runtime, snapshotAtom);
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const visibleAtom = commands.snapshotAtom(ENVIRONMENT_ID);
  registry.mount(visibleAtom);
  return { registry, commands, snapshotAtom, visibleAtom, requests };
});
