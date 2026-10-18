import { requestGuarded, runStreamGuarded } from "../rpc/client.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { RpcSession } from "../rpc/session.ts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  ThreadId,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  ScheduledTaskId,
  WS_METHODS,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import { createSignalboxAskCommand } from "./signalboxAsks.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";
import { SIGNALBOX_ANALYTICS_WS_METHODS } from "@t3tools/contracts/signalboxAnalytics";
import { PERSON_TIMEZONE_WS_METHODS } from "@t3tools/contracts/personTimezone";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const env = EnvironmentId.make("target");
const other = EnvironmentId.make("other");
const grant = (allowed: boolean): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: allowed ? [AuthOrchestrationOperateScope] : [],
  permissions: allowed ? [AuthOrchestrationOperateScope] : [],
});
const runtime = Atom.runtime(
  Layer.succeed(EnvironmentRegistry, {
    run: (_id: EnvironmentId, effect: Effect.Effect<unknown>) => effect,
  } as unknown as EnvironmentRegistry["Service"]),
);
const permissions = createCommandPermissions(runtime, WS_METHODS.scheduledTasksDelete);
const setup = Effect.gen(function* () {
  const registry = AtomRegistry.make();
  registry.mount(sessions(env));
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  return registry;
});

describe("command permissions", () => {
  it.effect("requires the destination provider grant for sign-in answers and logout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        for (const tag of [WS_METHODS.providerAuthRespond, WS_METHODS.providerAuthLogout]) {
          const command = createCommandPermissions(runtime, tag);
          registry.set(sessions(env), AsyncResult.success(grant(true)));
          expect(registry.get(command.permissionAtom(env))).toBe(false);
          expect((yield* Effect.flip(command.authorize(registry, env)))._tag).toBe(
            "EnvironmentAuthorizationError",
          );
          registry.set(
            sessions(env),
            AsyncResult.success({
              ...grant(true),
              scopes: [AuthProvidersManageScope],
              permissions: [AuthProvidersManageScope],
            }),
          );
          expect(registry.get(command.permissionAtom(env))).toBe(true);
          yield* command.authorize(registry, env);
          expect(registry.get(command.permissionAtom(other))).toBe(false);
        }
      }),
    ),
  );
  it.effect("requires an operate grant to answer durable asks", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const asks = createCommandPermissions(runtime, ORCHESTRATION_V2_WS_METHODS.dispatchCommand);
        const input = { type: "thread.ask.answer" };
        registry.set(sessions(env), AsyncResult.success(grant(false)));
        expect(registry.get(createSignalboxAskCommand(runtime).permissionAtom(env))).toBe(false);
        expect(registry.get(asks.permissionAtom(env, { type: "thread.snooze" }))).toBe(false);
        expect(registry.get(asks.permissionAtom(env, input))).toBe(false);
        expect((yield* asks.authorize(registry, env, input).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(asks.permissionAtom(env, input))).toBe(true);
        yield* asks.authorize(registry, env, input);
      }),
    ),
  );
  it.effect("requires a terminal grant on the destination for terminal mutations", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        const tags = [
          WS_METHODS.terminalOpen,
          WS_METHODS.terminalWrite,
          WS_METHODS.terminalResize,
          WS_METHODS.terminalClear,
          WS_METHODS.terminalRestart,
          WS_METHODS.terminalClose,
        ] as const;
        for (const tag of tags) {
          const terminal = createCommandPermissions(runtime, tag);
          expect(registry.get(terminal.permissionAtom(env))).toBe(false);
          expect(
            (yield* terminal.authorize(registry, env).pipe(Effect.flip)).requiredPermission,
          ).toBe(AuthTerminalOperateScope);
        }
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthTerminalOperateScope],
            permissions: [AuthTerminalOperateScope],
          }),
        );
        for (const tag of tags) {
          const terminal = createCommandPermissions(runtime, tag);
          expect(registry.get(terminal.permissionAtom(env))).toBe(true);
          yield* terminal.authorize(registry, env);
          expect(registry.get(terminal.permissionAtom(other))).toBe(false);
        }
      }),
    ),
  );

  it.effect("requires the current destination operate grant for provider feedback", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const feedback = createCommandPermissions(runtime, WS_METHODS.providerUploadFeedback);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(feedback.permissionAtom(env))).toBe(true);
        yield* feedback.authorize(registry, env);
        registry.set(sessions(env), AsyncResult.success(grant(false)));
        expect(registry.get(feedback.permissionAtom(env))).toBe(false);
        expect((yield* feedback.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
      }),
    ),
  );
  it.effect("requires the destination's orchestration grant to cancel preparation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const cancel = createCommandPermissions(runtime, WS_METHODS.worktreeSetupCancel);
        registry.set(sessions(other), AsyncResult.success(grant(true)));
        registry.set(sessions(env), AsyncResult.success(grant(false)));
        expect(registry.get(cancel.permissionAtom(env))).toBe(false);
        expect((yield* cancel.authorize(registry, env).pipe(Effect.flip)).requiredScope).toBe(
          AuthOrchestrationOperateScope,
        );
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(cancel.permissionAtom(env))).toBe(true);
        yield* cancel.authorize(registry, env);
      }),
    ),
  );

  it.effect.each([WS_METHODS.serverUpsertKeybinding, WS_METHODS.serverRemoveKeybinding])(
    "requires the destination settings grant for %s",
    (method) =>
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* setup;
          const command = createCommandPermissions(runtime, method);
          registry.set(sessions(env), AsyncResult.success(grant(true)));
          expect(registry.get(command.permissionAtom(env))).toBe(false);
          expect((yield* command.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
            "EnvironmentAuthorizationError",
          );
          registry.set(
            sessions(env),
            AsyncResult.success({
              ...grant(true),
              scopes: [AuthSettingsWriteScope],
              permissions: [AuthSettingsWriteScope],
            }),
          );
          expect(registry.get(command.permissionAtom(env))).toBe(true);
          yield* command.authorize(registry, env);
          registry.set(sessions(other), AsyncResult.success(grant(false)));
          expect(registry.get(command.permissionAtom(other))).toBe(false);
        }),
      ),
  );

  it.effect.each([PERSON_TIMEZONE_WS_METHODS.set, PERSON_TIMEZONE_WS_METHODS.report])(
    "requires the destination settings grant for %s",
    (method) =>
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* setup;
          const timezone = createCommandPermissions(runtime, method);
          registry.set(sessions(env), AsyncResult.success(grant(true)));
          expect(registry.get(timezone.permissionAtom(env))).toBe(false);
          expect((yield* timezone.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
            "EnvironmentAuthorizationError",
          );
          registry.set(
            sessions(env),
            AsyncResult.success({
              ...grant(true),
              scopes: [AuthSettingsWriteScope],
              permissions: [AuthSettingsWriteScope],
            }),
          );
          expect(registry.get(timezone.permissionAtom(env))).toBe(true);
          yield* timezone.authorize(registry, env);
          registry.set(sessions(other), AsyncResult.success(grant(false)));
          expect(registry.get(timezone.permissionAtom(other))).toBe(false);
        }),
      ),
  );

  it.effect("requires the destination settings grant to save analytics consent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const analytics = createCommandPermissions(
          runtime,
          SIGNALBOX_ANALYTICS_WS_METHODS.setEnabled,
        );
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(analytics.permissionAtom(env))).toBe(false);
        expect((yield* analytics.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(true),
            scopes: [AuthSettingsWriteScope],
            permissions: [AuthSettingsWriteScope],
          }),
        );
        expect(registry.get(analytics.permissionAtom(env))).toBe(true);
        yield* analytics.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(analytics.permissionAtom(other))).toBe(false);
      }),
    ),
  );

  it.effect("guards dispatch commands with the target orchestration grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const dispatch = createCommandPermissions(
          runtime,
          ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
        );
        expect(dispatch.requiredScopes()).toEqual([AuthOrchestrationOperateScope]);

        registry.set(sessions(env), AsyncResult.success(grant(true)));
        const permissionChanges: boolean[] = [];
        const unsubscribe = registry.subscribe(
          dispatch.permissionAtom(env),
          (allowed) => permissionChanges.push(allowed),
          { immediate: true },
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
        expect(permissionChanges).toEqual([true]);
        yield* dispatch.authorize(registry, env);

        registry.set(sessions(env), AsyncResult.success(grant(false)));
        expect(permissionChanges).toEqual([true, false]);
        const denied = yield* dispatch.authorize(registry, env).pipe(Effect.flip);
        expect(denied._tag).toBe("EnvironmentAuthorizationError");
      }),
    ),
  );

  it.effect("requires the destination settings grant to run storage cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const cleanup = createCommandPermissions(runtime, WS_METHODS.serverRunStorageCleanup);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(cleanup.permissionAtom(env))).toBe(false);
        expect((yield* cleanup.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(true),
            scopes: [AuthSettingsWriteScope],
            permissions: [AuthSettingsWriteScope],
          }),
        );
        expect(registry.get(cleanup.permissionAtom(env))).toBe(true);
        yield* cleanup.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(cleanup.permissionAtom(other))).toBe(false);
      }),
    ),
  );

  it.effect("requires the destination settings grant to check OTLP endpoints", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const check = createCommandPermissions(runtime, WS_METHODS.serverCheckOtlpEndpoint);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(check.permissionAtom(env))).toBe(false);
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthSettingsWriteScope],
            permissions: [AuthSettingsWriteScope],
          }),
        );
        expect(registry.get(check.permissionAtom(env))).toBe(true);
        yield* check.authorize(registry, env);
      }),
    ),
  );

  it.effect("guards device-open cancellation with the destination operate grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const cancelOpen = createCommandPermissions(runtime, WS_METHODS.deviceCancelOpen);
        registry.set(sessions(env), AsyncResult.success(grant(false)));
        expect(registry.get(cancelOpen.permissionAtom(env))).toBe(false);
        expect((yield* cancelOpen.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(cancelOpen.permissionAtom(env))).toBe(true);
        yield* cancelOpen.authorize(registry, env);
      }),
    ),
  );

  it.effect("uses the target grant for both availability and execution", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(permissions.permissionAtom(env))).toBe(true);
        expect(permissions.permissionAtom(env)).toBe(permissions.permissionAtom(env));
        yield* permissions.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(permissions.permissionAtom(other))).toBe(false);
        const denied = yield* permissions.authorize(registry, other).pipe(Effect.flip);
        expect(denied._tag).toBe("EnvironmentAuthorizationError");
      }),
    ),
  );
  it.effect(
    "uses the same refusal before and after authorization while allowing unknown grants to load",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* setup;
          expect(permissions.check(registry, env)).toBeNull();
          registry.set(sessions(env), AsyncResult.success(grant(false)));
          const known = permissions.check(registry, env);
          const awaited = yield* permissions.authorize(registry, env).pipe(Effect.flip);
          expect(known).not.toBeNull();
          expect(known?.requiredScope).toBe(awaited.requiredScope);
          expect(known?.requiredPermission).toBe(awaited.requiredPermission);
          expect(known?.message).toBe(awaited.message);
          registry.set(sessions(env), AsyncResult.success(grant(true)));
          expect(permissions.check(registry, env)).toBeNull();
        }),
      ),
  );

  it.effect("waits for an initial grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const fiber = yield* permissions.authorize(registry, env).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        yield* Fiber.join(fiber);
      }),
    ),
  );
  it.effect("bounds a session that never loads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const fiber = yield* permissions
          .authorize(registry, env)
          .pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust("6 seconds");
        expect((yield* Fiber.join(fiber))._tag).toBe("EnvironmentAuthorizationError");
      }),
    ),
  );
  it.effect(
    "denies failed and unauthenticated sessions, but accepts a cached refreshing grant",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* setup;
          registry.set(sessions(env), AsyncResult.failure(Cause.fail("offline")));
          expect((yield* permissions.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
            "EnvironmentAuthorizationError",
          );
          registry.set(
            sessions(env),
            AsyncResult.success({ ...grant(true), authenticated: false }),
          );
          expect((yield* permissions.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
            "EnvironmentAuthorizationError",
          );
          registry.set(sessions(env), AsyncResult.waiting(AsyncResult.success(grant(true))));
          yield* permissions.authorize(registry, env);
        }),
      ),
  );
  it("rechecks permission after waiting in a serial command lane", async () => {
    const registry = AtomRegistry.make();
    const unmount = registry.mount(sessions(env));
    registry.set(sessions(env), AsyncResult.success(grant(true)));
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const command = createEnvironmentRpcCommand(runtime, {
      label: "test.delete",
      tag: WS_METHODS.scheduledTasksDelete,
      concurrency: { mode: "serial", key: () => "target" },
      execute: () =>
        Effect.promise(async () => {
          calls++;
          started();
          await gate;
          return { id: ScheduledTaskId.make("task") };
        }),
    });
    const target = { environmentId: env, input: { id: ScheduledTaskId.make("task") } };
    try {
      const first = command.run(registry, target);
      await entered;
      const second = command.run(registry, target);
      registry.set(sessions(env), AsyncResult.success(grant(false)));
      release();
      expect((await first)._tag).toBe("Success");
      expect((await second)._tag).toBe("Failure");
      expect(calls).toBe(1);
    } finally {
      unmount();
      registry.dispose();
    }
  });
});

it.effect(
  "requires source control alone for git, and both grants when attaching a worktree to a thread",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        const git = createCommandPermissions(runtime, WS_METHODS.vcsInit);
        expect((yield* git.authorize(registry, env).pipe(Effect.flip)).requiredPermission).toBe(
          AuthSourceControlWriteScope,
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthSourceControlWriteScope],
            permissions: [AuthSourceControlWriteScope],
          }),
        );
        yield* git.authorize(registry, env);
        const prepare = createCommandPermissions(runtime, WS_METHODS.gitPreparePullRequestThread);
        const input = {
          cwd: "/repo",
          reference: "123",
          mode: "worktree",
          threadId: ThreadId.make("thread"),
        };
        expect(registry.get(prepare.permissionAtom(env, input))).toBe(false);
        expect(
          (yield* prepare.authorize(registry, env, input).pipe(Effect.flip)).requiredScope,
        ).toBe(AuthOrchestrationOperateScope);
        yield* prepare.authorize(registry, env, { ...input, threadId: undefined });
        expect(
          (yield* prepare
            .authorize(registry, env, {
              ...input,
              mode: "local",
              threadId: undefined,
              operationId: "prepare-pr",
            })
            .pipe(Effect.flip)).requiredScope,
        ).toBe(AuthOrchestrationOperateScope);
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(true),
            scopes: [AuthSourceControlWriteScope, AuthOrchestrationOperateScope],
            permissions: [AuthSourceControlWriteScope, AuthOrchestrationOperateScope],
          }),
        );
        expect(registry.get(prepare.permissionAtom(env, input))).toBe(true);
        yield* prepare.authorize(registry, env, input);
      }),
    ),
);

it.effect("honors exact empty permissions and preserves legacy parent grants", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* setup;
      const git = createCommandPermissions(runtime, WS_METHODS.vcsInit);
      registry.set(sessions(env), AsyncResult.success({ ...grant(true), permissions: [] }));
      expect(registry.get(git.permissionAtom(env))).toBe(false);
      const denied = yield* git.authorize(registry, env).pipe(Effect.flip);
      expect(denied).toMatchObject({
        requiredPermission: AuthSourceControlWriteScope,
        requiredScope: AuthOrchestrationOperateScope,
      });
      const { permissions: _exact, ...legacy } = grant(true);
      registry.set(sessions(env), AsyncResult.success(legacy));
      expect(registry.get(git.permissionAtom(env))).toBe(true);
      yield* git.authorize(registry, env);
    }),
  ),
);

it.effect("rejects protected unary and streamed RPCs outside a guarded command", () =>
  Effect.gen(function* () {
    let writes = 0;
    const session = {
      client: {
        [WS_METHODS.scheduledTasksDelete]: () =>
          Effect.sync(() => {
            writes++;
            return { id: ScheduledTaskId.make("task") };
          }),
        [WS_METHODS.gitRunStackedAction]: () =>
          Stream.fromEffect(
            Effect.sync(() => {
              writes++;
            }),
          ),
      },
    } as unknown as RpcSession;
    const supervisor = {
      target: { environmentId: env, label: "target" },
      session: yield* SubscriptionRef.make(Option.some(session)),
    } as unknown as EnvironmentSupervisor["Service"];
    const unary = yield* requestGuarded(WS_METHODS.scheduledTasksDelete, {
      id: ScheduledTaskId.make("task"),
    }).pipe(Effect.provideService(EnvironmentSupervisor, supervisor), Effect.flip);
    expect(unary._tag).toBe("EnvironmentAuthorizationError");
    const streamed = yield* runStreamGuarded(WS_METHODS.gitRunStackedAction, {
      actionId: "test-action",
      cwd: "/repo",
      action: "commit",
    }).pipe(Stream.runDrain, Effect.provideService(EnvironmentSupervisor, supervisor), Effect.flip);
    expect(streamed._tag).toBe("EnvironmentAuthorizationError");
    expect(writes).toBe(0);
  }),
);
