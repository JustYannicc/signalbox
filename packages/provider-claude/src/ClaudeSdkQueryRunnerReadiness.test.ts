import type {
  Query as ClaudeQuery,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { makeClaudeUserMessage } from "@signalbox/provider-claude/ClaudeAdapter";
import {
  type ClaudeAgentSdkMcpServers,
  type ClaudeAgentSdkQueryRunnerError,
  type ClaudeAgentSdkQueryOptions,
} from "@signalbox/provider-claude/ClaudeQueryRunner";
import {
  makeClaudeAgentSdkQueryRunner,
  type ClaudeSdkQuery,
} from "@signalbox/provider-claude/ClaudeSdkQueryRunner";

const identity = {
  threadId: ThreadId.make("query-readiness-thread"),
  providerSessionId: ProviderSessionId.make("query-readiness-session"),
};

const queryOptions: ClaudeAgentSdkQueryOptions = {
  sessionId: "query-readiness-native-session",
  model: "claude-opus-4-6",
  tools: [],
  permissionMode: "default",
};

type InitializationResult = Awaited<ReturnType<ClaudeQuery["initializationResult"]>>;
type QueryWithInitialization = ClaudeSdkQuery & Pick<ClaudeQuery, "initializationResult">;
type PreCleanupDiagnostic = {
  readonly phase: "query-acquisition" | "initialization" | "mcp-registration";
  readonly cause: Cause.Cause<ClaudeAgentSdkQueryRunnerError>;
  readonly mcpSignal:
    | { readonly present: false }
    | { readonly present: true; readonly aborted: boolean; readonly reason: unknown };
};

type McpRegistrationResult = {
  added: string[];
  removed: string[];
  errors: Record<string, string>;
};

function queryFixture(): QueryWithInitialization {
  async function* messages(): AsyncGenerator<SDKMessage> {}
  return Object.assign(messages(), {
    initializationResult: async () => ({}) as InitializationResult,
    close: () => {},
    setMcpServers: async (servers: ClaudeAgentSdkMcpServers) => ({
      added: Object.keys(servers),
      removed: [],
      errors: {},
    }),
    setModel: async (_model: string) => {},
    applyFlagSettings: async (_settings: Parameters<ClaudeSdkQuery["applyFlagSettings"]>[0]) => {},
    setPermissionMode: async (_mode: Parameters<ClaudeSdkQuery["setPermissionMode"]>[0]) => {},
    stopTask: async (_taskId: string) => {},
    backgroundTasks: async (_toolUseId: string) => true,
    interrupt: async () => undefined,
  }) satisfies QueryWithInitialization;
}

const mcpServers: ClaudeAgentSdkMcpServers = {
  signalbox: { type: "http", url: "https://harness-mcp.invalid/thread/1" },
};

describe("Claude SDK query readiness", () => {
  it.effect("waits for SDK initialization before starting the MCP deadline", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const queryCreated = yield* Deferred.make<void>();
        const readyResult = {} as InitializationResult;
        let resolveReady!: (result: InitializationResult) => void;
        const initialization = new Promise<InitializationResult>((resolve) => {
          resolveReady = resolve;
        });
        let resolveRegistration!: (result: {
          added: string[];
          removed: string[];
          errors: Record<string, string>;
        }) => void;
        const registrationAck = new Promise<{
          added: string[];
          removed: string[];
          errors: Record<string, string>;
        }>((resolve) => {
          resolveRegistration = resolve;
        });
        let registrationStarted!: () => void;
        const registrationStart = new Promise<void>((resolve) => {
          registrationStarted = resolve;
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            resolveReady(readyResult);
            resolveRegistration({ added: [], removed: [], errors: {} });
          }),
        );
        const query = queryFixture();
        let initializationStarted = false;
        let registrations = 0;
        let closes = 0;
        let openFinished = false;
        let prompt: AsyncIterable<SDKUserMessage> | undefined;
        query.initializationResult = () => {
          initializationStarted = true;
          return initialization;
        };
        query.setMcpServers = async (servers) => {
          registrations += 1;
          registrationStarted();
          return registrationAck.then((ack) => ({ ...ack, added: Object.keys(servers) }));
        };
        query.close = () => {
          closes += 1;
        };
        const runner = makeClaudeAgentSdkQueryRunner({
          allocateSessionId: Effect.succeed("allocated-session"),
          requireMcpServerRegistration: true,
          resolveMcpServers: () =>
            Effect.succeed({ servers: mcpServers, signal: new AbortController().signal }),
          query: (open) =>
            Deferred.succeed(queryCreated, undefined).pipe(
              Effect.map(() => {
                prompt = open.prompt;
                return query;
              }),
            ),
          forkSession: async () => ({ sessionId: "forked-session" }),
          subagentLaunchToolUseId: async () => null,
        });
        const opening = yield* runner.open({ ...identity, options: queryOptions }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              openFinished = true;
            }),
          ),
          Effect.forkScoped,
        );

        yield* Deferred.await(queryCreated);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("91 seconds");

        assert.equal(registrations, 0);
        assert.equal(closes, 0);
        assert.isFalse(openFinished);
        assert.isTrue(initializationStarted);

        resolveReady(readyResult);
        yield* Effect.promise(() => registrationStart);
        assert.isFalse(openFinished);
        resolveRegistration({ added: [], removed: [], errors: {} });
        const session = yield* Fiber.join(opening);
        assert.isTrue(openFinished);
        assert.equal(registrations, 1);

        const message = makeClaudeUserMessage({ text: "only after MCP ACK" });
        const incoming = prompt![Symbol.asyncIterator]();
        yield* session.offer(message);
        assert.deepEqual(yield* Effect.promise(() => incoming.next()), {
          value: message,
          done: false,
        });
        yield* session.close;
        assert.equal(closes, 1);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("captures the 90-second registration timeout before query cleanup", () => {
    const signal = new AbortController().signal;
    return Effect.scoped(
      Effect.gen(function* () {
        const readyResult = {} as InitializationResult;
        let resolveRegistration!: (result: McpRegistrationResult) => void;
        const pendingRegistration = new Promise<McpRegistrationResult>((resolve) => {
          resolveRegistration = resolve;
        });
        let registrationStarted!: () => void;
        const registrationStart = new Promise<void>((resolve) => {
          registrationStarted = resolve;
        });
        const query = queryFixture();
        query.initializationResult = async () => readyResult;
        query.setMcpServers = () => {
          registrationStarted();
          return pendingRegistration;
        };
        const diagnostics: PreCleanupDiagnostic[] = [];
        const order: string[] = [];
        const cleanupFailure = new Error("query-close-cleanup");
        let closes = 0;
        query.close = () => {
          closes += 1;
          order.push("close");
          throw cleanupFailure;
        };
        const runnerOptions = {
          allocateSessionId: Effect.succeed("allocated-session"),
          requireMcpServerRegistration: true,
          resolveMcpServers: () => Effect.succeed({ servers: mcpServers, signal }),
          onPreCleanupDiagnostic: (diagnostic: PreCleanupDiagnostic) => {
            diagnostics.push(diagnostic);
            order.push("diagnostic");
          },
          query: () => Effect.succeed(query),
          forkSession: async () => ({ sessionId: "forked-session" }),
          subagentLaunchToolUseId: async () => null,
        };
        const runner = makeClaudeAgentSdkQueryRunner(runnerOptions);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => resolveRegistration({ added: [], removed: [], errors: {} })),
        );
        const opening = yield* runner
          .open({ ...identity, options: queryOptions })
          .pipe(Effect.forkScoped);

        yield* Effect.promise(() => registrationStart);
        yield* TestClock.adjust(0);
        yield* TestClock.adjust("90 seconds");
        const failure = yield* Effect.exit(Fiber.join(opening));

        if (!Exit.isFailure(failure))
          throw new Error("The unacknowledged registration must time out.");
        assert.equal(closes, 1);
        assert.deepEqual(order, ["diagnostic", "close"]);
        assert.equal(diagnostics.length, 1);
        const diagnostic = diagnostics[0]!;
        assert.equal(diagnostic.phase, "mcp-registration");
        assert.isTrue(diagnostic.mcpSignal.present);
        if (diagnostic.mcpSignal.present) {
          assert.isFalse(diagnostic.mcpSignal.aborted);
          assert.strictEqual(diagnostic.mcpSignal.reason, signal.reason);
        }
        assert.include(
          Cause.pretty(diagnostic.cause),
          "did not answer the MCP server registration",
        );
        assert.notInclude(Cause.pretty(diagnostic.cause), cleanupFailure.message);
        assert.include(Cause.pretty(failure.cause), cleanupFailure.message);
        assert.notStrictEqual(diagnostic.cause, failure.cause);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });
});
