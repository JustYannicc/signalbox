import type { Query as ClaudeQuery, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { ClaudeAgentSdkQueryRunnerError } from "@signalbox/provider-claude/ClaudeQueryRunner";
import {
  makeClaudeAgentSdkQueryRunner,
  type ClaudeSdkQuery,
  type ClaudeSdkQueryPreCleanupDiagnostic,
} from "@signalbox/provider-claude/ClaudeSdkQueryRunner";

const identity = {
  threadId: ThreadId.make("pre-cleanup-thread"),
  providerSessionId: ProviderSessionId.make("pre-cleanup-session"),
};

const queryOptions = {
  sessionId: "pre-cleanup-native-session",
  model: "claude-opus-4-6",
  tools: [],
  permissionMode: "default" as const,
};

const mcpServers = {
  signalbox: { type: "http" as const, url: "https://harness-mcp.invalid/thread/1" },
};

type InitializationResult = Awaited<ReturnType<ClaudeQuery["initializationResult"]>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function queryFixture(): ClaudeSdkQuery {
  async function* messages(): AsyncGenerator<SDKMessage> {}
  return Object.assign(messages(), {
    initializationResult: async () => ({}) as InitializationResult,
    close: () => {},
    setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
    setModel: async (_model: string) => {},
    applyFlagSettings: async (_settings: Parameters<ClaudeSdkQuery["applyFlagSettings"]>[0]) => {},
    setPermissionMode: async (_mode: Parameters<ClaudeSdkQuery["setPermissionMode"]>[0]) => {},
    stopTask: async (_taskId: string) => {},
    backgroundTasks: async (_toolUseId: string) => true,
    interrupt: async () => undefined,
  }) satisfies ClaudeSdkQuery;
}

function runnerFor(
  query: ClaudeSdkQuery,
  signal: AbortSignal | undefined,
  onDiagnostic: (diagnostic: ClaudeSdkQueryPreCleanupDiagnostic) => void,
) {
  const options = {
    allocateSessionId: Effect.succeed("allocated-session"),
    requireMcpServerRegistration: true,
    ...(signal === undefined
      ? {}
      : { resolveMcpServers: () => Effect.succeed({ servers: mcpServers, signal }) }),
    onPreCleanupDiagnostic: onDiagnostic,
    query: () => Effect.succeed(query),
    forkSession: async () => ({ sessionId: "forked-session" }),
    subagentLaunchToolUseId: async () => null,
  };
  return makeClaudeAgentSdkQueryRunner(options);
}

const openOptions = { ...queryOptions, mcpServers };

describe("Claude query pre-cleanup diagnostics", () => {
  it.effect("captures initialization failure before closing the acquired Query", () => {
    const signal = new AbortController().signal;
    return Effect.scoped(
      Effect.gen(function* () {
        const initializationFailure = new Error("SDK initialization failed");
        const query = queryFixture();
        query.initializationResult = async () => {
          throw initializationFailure;
        };
        let registrations = 0;
        query.setMcpServers = async () => {
          registrations += 1;
          return { added: [], removed: [], errors: {} };
        };
        let closes = 0;
        const order: string[] = [];
        query.close = () => {
          closes += 1;
          order.push("close");
        };
        const diagnostics: ClaudeSdkQueryPreCleanupDiagnostic[] = [];
        const runner = runnerFor(query, signal, (diagnostic) => {
          diagnostics.push(diagnostic);
          order.push("diagnostic");
        });

        const failure = yield* Effect.exit(runner.open({ ...identity, options: openOptions }));

        if (!Exit.isFailure(failure))
          throw new Error("Initialization failure must reject query open.");
        assert.equal(registrations, 0);
        assert.equal(closes, 1);
        assert.deepEqual(order, ["diagnostic", "close"]);
        assert.equal(diagnostics.length, 1);
        const diagnostic = diagnostics[0]!;
        assert.equal(diagnostic.phase, "initialization");
        assert.isTrue(diagnostic.mcpSignal.present);
        if (diagnostic.mcpSignal.present) {
          assert.isFalse(diagnostic.mcpSignal.aborted);
          assert.strictEqual(diagnostic.mcpSignal.reason, undefined);
        }
        assert.include(Cause.pretty(diagnostic.cause), initializationFailure.message);
        assert.include(Cause.pretty(failure.cause), initializationFailure.message);
      }),
    );
  });

  it.effect(
    "captures the epoch abort during initialization before closing the acquired Query",
    () => {
      const controller = new AbortController();
      return Effect.scoped(
        Effect.gen(function* () {
          const initialization = deferred<InitializationResult>();
          const initializationStarted = deferred<void>();
          const query = queryFixture();
          query.initializationResult = () => {
            initializationStarted.resolve(undefined);
            return initialization.promise;
          };
          let registrations = 0;
          query.setMcpServers = async () => {
            registrations += 1;
            return { added: [], removed: [], errors: {} };
          };
          let closes = 0;
          const order: string[] = [];
          query.close = () => {
            closes += 1;
            order.push("close");
          };
          const reason = new Error("native access expired during initialize");
          const diagnostics: ClaudeSdkQueryPreCleanupDiagnostic[] = [];
          const runner = runnerFor(query, controller.signal, (diagnostic) => {
            diagnostics.push(diagnostic);
            order.push("diagnostic");
          });
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => initialization.resolve({} as InitializationResult)),
          );
          const opening = yield* runner
            .open({ ...identity, options: queryOptions })
            .pipe(Effect.forkScoped);

          yield* Effect.promise(() => initializationStarted.promise);
          controller.abort(reason);
          const failure = yield* Effect.exit(Fiber.join(opening));

          assert.isTrue(Exit.isFailure(failure));
          assert.equal(registrations, 0);
          assert.equal(closes, 1);
          assert.deepEqual(order, ["diagnostic", "close"]);
          assert.equal(diagnostics.length, 1);
          const diagnostic = diagnostics[0]!;
          assert.equal(diagnostic.phase, "initialization");
          assert.isTrue(diagnostic.mcpSignal.present);
          if (diagnostic.mcpSignal.present) {
            assert.isTrue(diagnostic.mcpSignal.aborted);
            assert.strictEqual(diagnostic.mcpSignal.reason, reason);
          }
          assert.include(Cause.pretty(diagnostic.cause), reason.message);
        }),
      );
    },
  );

  it.effect("captures caller interruption during initialization with explicit signal absence", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const initialization = deferred<InitializationResult>();
        const initializationStarted = deferred<void>();
        const query = queryFixture();
        query.initializationResult = () => {
          initializationStarted.resolve(undefined);
          return initialization.promise;
        };
        let closes = 0;
        const order: string[] = [];
        query.close = () => {
          closes += 1;
          order.push("close");
        };
        const diagnostics: ClaudeSdkQueryPreCleanupDiagnostic[] = [];
        const runner = runnerFor(query, undefined, (diagnostic) => {
          diagnostics.push(diagnostic);
          order.push("diagnostic");
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => initialization.resolve({} as InitializationResult)),
        );
        const opening = yield* runner
          .open({ ...identity, options: openOptions })
          .pipe(Effect.forkScoped);

        yield* Effect.promise(() => initializationStarted.promise);
        yield* Fiber.interrupt(opening);
        const failure = yield* Effect.exit(Fiber.join(opening));

        assert.isTrue(Exit.isFailure(failure));
        assert.equal(closes, 1);
        assert.deepEqual(order, ["diagnostic", "close"]);
        assert.equal(diagnostics.length, 1);
        const diagnostic = diagnostics[0]!;
        assert.equal(diagnostic.phase, "initialization");
        assert.deepEqual(diagnostic.mcpSignal, { present: false });
        assert.isTrue(Cause.hasInterrupts(diagnostic.cause));
      }),
    ),
  );

  it.effect("keeps the original failure and closes once when the diagnostic callback throws", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const initializationFailure = new Error("original initialization failure");
        const observerFailure = new Error("diagnostic capture failed");
        const query = queryFixture();
        query.initializationResult = async () => {
          throw initializationFailure;
        };
        let closes = 0;
        const order: string[] = [];
        query.close = () => {
          closes += 1;
          order.push("close");
        };
        const diagnostics: ClaudeSdkQueryPreCleanupDiagnostic[] = [];
        const runner = runnerFor(query, undefined, (diagnostic) => {
          diagnostics.push(diagnostic);
          order.push("diagnostic");
          throw observerFailure;
        });

        const failure = yield* Effect.exit(runner.open({ ...identity, options: openOptions }));

        if (!Exit.isFailure(failure))
          throw new Error("A diagnostic failure must reject query open.");
        assert.equal(closes, 1);
        assert.deepEqual(order, ["diagnostic", "close"]);
        assert.equal(diagnostics.length, 1);
        assert.include(Cause.pretty(diagnostics[0]!.cause), initializationFailure.message);
        assert.notInclude(Cause.pretty(diagnostics[0]!.cause), observerFailure.message);
        assert.include(Cause.pretty(failure.cause), initializationFailure.message);
        assert.include(Cause.pretty(failure.cause), observerFailure.message);
      }),
    ),
  );
});
