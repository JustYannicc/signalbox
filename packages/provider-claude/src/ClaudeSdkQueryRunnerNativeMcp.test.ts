import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { makeClaudeUserMessage } from "@signalbox/provider-claude/ClaudeAdapter";
import {
  type ClaudeAgentSdkMcpServers,
  type ClaudeAgentSdkQueryOptions,
} from "@signalbox/provider-claude/ClaudeQueryRunner";
import {
  makeClaudeAgentSdkQueryRunner,
  type ClaudeSdkQuery,
} from "@signalbox/provider-claude/ClaudeSdkQueryRunner";

const identity = {
  threadId: ThreadId.make("native-mcp-thread"),
  providerSessionId: ProviderSessionId.make("native-mcp-session"),
};
const queryOptions: ClaudeAgentSdkQueryOptions = {
  sessionId: "native-mcp-session-id",
  model: "claude-opus-4-6",
  tools: [],
  permissionMode: "default",
};

function queryFixture(): ClaudeSdkQuery {
  async function* messages(): AsyncGenerator<SDKMessage> {}
  return Object.assign(messages(), {
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
  }) satisfies ClaudeSdkQuery;
}

const mcp = (name: string, url: string): ClaudeAgentSdkMcpServers => ({
  [name]: { type: "http", url },
});

describe("native Claude MCP query seam", () => {
  it.effect("waits for the real SDK ACK before exposing a prompt session", () =>
    Effect.gen(function* () {
      const order: string[] = [];
      let prompt: AsyncIterable<SDKUserMessage> | undefined;
      let launchOptions: unknown;
      let announceInstall!: () => void;
      let acknowledge!: () => void;
      let openFinished = false;
      const installStarted = new Promise<void>((resolve) => {
        announceInstall = resolve;
      });
      const installAck = new Promise<void>((resolve) => {
        acknowledge = resolve;
      });
      const mcpSignal = new AbortController().signal;
      const query = queryFixture();
      query.setMcpServers = async (servers) => {
        order.push(`install-started:${Object.keys(servers).join(",")}`);
        announceInstall();
        await installAck;
        order.push("install-acknowledged");
        return { added: Object.keys(servers), removed: [], errors: {} };
      };
      const nativeRunner = makeClaudeAgentSdkQueryRunner({
        allocateSessionId: Effect.succeed("allocated-session"),
        requireMcpServerRegistration: true,
        resolveMcpServers: () =>
          Effect.succeed({
            servers: mcp("signalbox", "https://harness-mcp.invalid/thread/1"),
            signal: mcpSignal,
          }),
        query: (open) =>
          Effect.sync(() => {
            order.push("query-created");
            prompt = open.prompt;
            launchOptions = open.options;
            return query;
          }),
        forkSession: async () => ({ sessionId: "forked-session" }),
        subagentLaunchToolUseId: async () => null,
      });
      const opening = yield* nativeRunner
        .open({
          ...identity,
          options: {
            ...queryOptions,
            mcpServers: mcp("provider-derived", "https://provider.invalid/old"),
          },
        })
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              openFinished = true;
            }),
          ),
          Effect.forkScoped,
        );
      yield* Effect.promise(() => installStarted);
      assert.isFalse(openFinished);
      acknowledge();
      const session = yield* Fiber.join(opening);

      assert.isTrue(openFinished);
      assert.deepEqual(order, [
        "query-created",
        "install-started:signalbox",
        "install-acknowledged",
      ]);
      assert.deepEqual(launchOptions, queryOptions);
      const message = makeClaudeUserMessage({ text: "first prompt" });
      const incoming = prompt![Symbol.asyncIterator]();
      yield* session.offer(message);
      assert.deepEqual(yield* Effect.promise(() => incoming.next()), {
        value: message,
        done: false,
      });
      yield* session.close;
    }),
  );

  it.effect("rejects ACK errors and closes the acquired SDK Query", () =>
    Effect.gen(function* () {
      let closed = false;
      const query = queryFixture();
      query.setMcpServers = async (servers) => ({
        added: [],
        removed: [],
        errors: { [Object.keys(servers)[0]!]: "credential-bearing SDK detail" },
      });
      query.close = () => {
        closed = true;
      };
      const nativeRunner = makeClaudeAgentSdkQueryRunner({
        allocateSessionId: Effect.succeed("allocated-session"),
        requireMcpServerRegistration: true,
        query: () => Effect.succeed(query),
        forkSession: async () => ({ sessionId: "forked-session" }),
        subagentLaunchToolUseId: async () => null,
      });
      const opened = yield* Effect.exit(
        nativeRunner.open({
          ...identity,
          options: { ...queryOptions, mcpServers: mcp("signalbox", "https://mcp.invalid/1") },
        }),
      );
      assert.isTrue(Exit.isFailure(opened));
      assert.isTrue(closed);
    }),
  );

  it.effect("retains both initial install and query cleanup failures", () =>
    Effect.gen(function* () {
      const primary = new Error("native-install-primary");
      const cleanup = new Error("native-query-close-cleanup");
      const query = queryFixture();
      query.setMcpServers = async () => {
        throw primary;
      };
      query.close = () => {
        throw cleanup;
      };
      const nativeRunner = makeClaudeAgentSdkQueryRunner({
        allocateSessionId: Effect.succeed("allocated-session"),
        requireMcpServerRegistration: true,
        resolveMcpServers: () =>
          Effect.succeed({
            servers: mcp("canonical", "https://harness-mcp.invalid/thread/initial"),
            signal: new AbortController().signal,
          }),
        query: () => Effect.succeed(query),
        forkSession: async () => ({ sessionId: "forked-session" }),
        subagentLaunchToolUseId: async () => null,
      });
      const opened = yield* Effect.exit(nativeRunner.open({ ...identity, options: queryOptions }));
      if (!Exit.isFailure(opened)) throw new Error("Initial strict MCP registration must fail.");
      const cause = Cause.pretty(opened.cause);
      assert.include(cause, primary.message);
      assert.include(cause, cleanup.message);
    }),
  );

  it.effect("aborts initial native registration and closes the acquired Query", () =>
    Effect.gen(function* () {
      let entered!: () => void;
      let finish!: (value: {
        added: string[];
        removed: string[];
        errors: Record<string, string>;
      }) => void;
      const installStarted = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const pending = new Promise<{
        added: string[];
        removed: string[];
        errors: Record<string, string>;
      }>((resolve) => {
        finish = resolve;
      });
      let closed = false;
      const query = queryFixture();
      query.close = () => {
        closed = true;
      };
      query.setMcpServers = async (_servers) => {
        entered();
        return pending;
      };
      const controller = new AbortController();
      const nativeRunner = makeClaudeAgentSdkQueryRunner({
        allocateSessionId: Effect.succeed("allocated-session"),
        requireMcpServerRegistration: true,
        resolveMcpServers: () =>
          Effect.succeed({
            servers: mcp("canonical", "https://harness-mcp.invalid/thread/initial"),
            signal: controller.signal,
          }),
        query: () => Effect.succeed(query),
        forkSession: async () => ({ sessionId: "forked-session" }),
        subagentLaunchToolUseId: async () => null,
      });
      const opening = yield* nativeRunner
        .open({ ...identity, options: queryOptions })
        .pipe(Effect.forkScoped);
      yield* Effect.promise(() => installStarted);
      controller.abort(new Error("checkpoint access ended"));
      const result = yield* Effect.exit(Fiber.join(opening));
      finish({ added: [], removed: [], errors: {} });
      assert.isTrue(Exit.isFailure(result));
      assert.isTrue(closed);
    }).pipe(Effect.scoped),
  );

  it.effect("joins Query acquisition after abort and closes the late Query", () =>
    Effect.gen(function* () {
      let entered!: () => void;
      const acquiring = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let acquired!: (query: ClaudeSdkQuery) => void;
      const pending = new Promise<ClaudeSdkQuery>((resolve) => {
        acquired = resolve;
      });
      let closed = false;
      const query = queryFixture();
      query.close = () => {
        closed = true;
      };
      const controller = new AbortController();
      const nativeRunner = makeClaudeAgentSdkQueryRunner({
        allocateSessionId: Effect.succeed("allocated-session"),
        requireMcpServerRegistration: true,
        resolveMcpServers: () => Effect.succeed({ servers: {}, signal: controller.signal }),
        query: () =>
          Effect.promise(() => {
            entered();
            return pending;
          }),
        forkSession: async () => ({ sessionId: "forked-session" }),
        subagentLaunchToolUseId: async () => null,
      });
      const opening = yield* nativeRunner
        .open({ ...identity, options: queryOptions })
        .pipe(Effect.forkScoped);
      yield* Effect.promise(() => acquiring);
      controller.abort(new Error("native access ended during acquisition"));
      yield* Effect.yieldNow;
      acquired(query);
      const result = yield* Effect.exit(Fiber.join(opening));
      assert.isTrue(Exit.isFailure(result));
      assert.isTrue(closed);
    }).pipe(Effect.scoped),
  );

  it.effect("reconfigures the retained Query and an empty map clears prior servers", () =>
    Effect.gen(function* () {
      const installed: Array<ReadonlyArray<string>> = [];
      let retained: unknown;
      let released: unknown;
      const query = queryFixture();
      query.setMcpServers = async (servers) => {
        installed.push(Object.keys(servers));
        return { added: Object.keys(servers), removed: [], errors: {} };
      };
      const nativeRunner = makeClaudeAgentSdkQueryRunner({
        allocateSessionId: Effect.succeed("allocated-session"),
        requireMcpServerRegistration: true,
        onQuerySessionOpened: (session) => {
          retained = session;
        },
        onQuerySessionClosed: (session) => {
          released = session;
        },
        query: () => Effect.succeed(query),
        forkSession: async () => ({ sessionId: "forked-session" }),
        subagentLaunchToolUseId: async () => null,
      });
      const session = yield* nativeRunner.open({
        ...identity,
        options: { ...queryOptions, mcpServers: mcp("first", "https://mcp.invalid/first") },
      });
      assert.strictEqual(retained, session);
      const configureMcp = session.configureMcp;
      if (configureMcp === undefined) throw new Error("native MCP control is unavailable");
      yield* configureMcp(
        mcp("second", "https://mcp.invalid/second"),
        new AbortController().signal,
      );
      yield* configureMcp({}, new AbortController().signal);
      assert.deepEqual(installed, [["first"], ["second"], []]);
      yield* session.close;
      assert.strictEqual(released, session);
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(session.offer(makeClaudeUserMessage({ text: "closed" }))),
        ),
      );
    }),
  );

  it.effect("uses a failed native ACK for retained reconfiguration and rejects later prompts", () =>
    Effect.gen(function* () {
      let installs = 0;
      let closed = false;
      const query = queryFixture();
      query.setMcpServers = async (servers) => {
        installs++;
        return {
          added: [],
          removed: [],
          errors: installs === 1 ? {} : { [Object.keys(servers)[0]!]: "retained-native-ack-error" },
        };
      };
      query.close = () => {
        closed = true;
      };
      const nativeRunner = makeClaudeAgentSdkQueryRunner({
        allocateSessionId: Effect.succeed("allocated-session"),
        requireMcpServerRegistration: true,
        query: () => Effect.succeed(query),
        forkSession: async () => ({ sessionId: "forked-session" }),
        subagentLaunchToolUseId: async () => null,
      });
      const session = yield* nativeRunner.open({
        ...identity,
        options: { ...queryOptions, mcpServers: mcp("initial", "https://mcp.invalid/initial") },
      });
      const configureMcp = session.configureMcp;
      if (configureMcp === undefined) throw new Error("native MCP control is unavailable");
      const reconfiguration = yield* Effect.exit(
        configureMcp(mcp("rejected", "https://mcp.invalid/rejected"), new AbortController().signal),
      );
      assert.isTrue(Exit.isFailure(reconfiguration));
      assert.isTrue(closed);
      assert.equal(installs, 2);
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(session.offer(makeClaudeUserMessage({ text: "closed" }))),
        ),
      );
    }),
  );

  it.effect("rejects concurrent MCP epochs and keeps the query fail-closed", () =>
    Effect.gen(function* () {
      let entered!: () => void;
      let finish!: (value: {
        added: string[];
        removed: string[];
        errors: Record<string, string>;
      }) => void;
      const installStarted = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const pending = new Promise<{
        added: string[];
        removed: string[];
        errors: Record<string, string>;
      }>((resolve) => {
        finish = resolve;
      });
      let closed = false;
      const query = queryFixture();
      query.close = () => {
        closed = true;
      };
      query.setMcpServers = async (servers) =>
        Object.hasOwn(servers, "pending")
          ? (entered(), pending)
          : { added: Object.keys(servers), removed: [], errors: {} };
      const nativeRunner = makeClaudeAgentSdkQueryRunner({
        allocateSessionId: Effect.succeed("allocated-session"),
        requireMcpServerRegistration: true,
        query: () => Effect.succeed(query),
        forkSession: async () => ({ sessionId: "forked-session" }),
        subagentLaunchToolUseId: async () => null,
      });
      const session = yield* nativeRunner.open({
        ...identity,
        options: { ...queryOptions, mcpServers: mcp("ready", "https://mcp.invalid/ready") },
      });
      const configureMcp = session.configureMcp;
      if (configureMcp === undefined) throw new Error("native MCP control is unavailable");
      const installing = yield* configureMcp(
        mcp("pending", "https://mcp.invalid/pending"),
        new AbortController().signal,
      ).pipe(Effect.forkScoped);
      yield* Effect.promise(() => installStarted);
      const concurrent = yield* Effect.exit(
        configureMcp(mcp("racing", "https://mcp.invalid/racing"), new AbortController().signal),
      );
      const prompt = yield* Effect.exit(
        session.offer(makeClaudeUserMessage({ text: "must wait" })),
      );
      finish({ added: ["pending"], removed: [], errors: {} });
      const first = yield* Effect.exit(Fiber.join(installing));
      assert.isTrue(Exit.isFailure(concurrent));
      assert.isTrue(Exit.isFailure(first));
      assert.isTrue(Exit.isFailure(prompt));
      assert.isTrue(closed);
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(session.offer(makeClaudeUserMessage({ text: "failed" }))),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("aborts an in-flight native install and keeps the query fail-closed", () =>
    Effect.gen(function* () {
      let entered!: () => void;
      const installationStarted = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let finish!: (value: {
        added: string[];
        removed: string[];
        errors: Record<string, string>;
      }) => void;
      const pendingInstall = new Promise<{
        added: string[];
        removed: string[];
        errors: Record<string, string>;
      }>((resolve) => {
        finish = resolve;
      });
      let closed = false;
      const query = queryFixture();
      query.close = () => {
        closed = true;
      };
      query.setMcpServers = async (servers) => {
        if (Object.hasOwn(servers, "pending")) {
          entered();
          return pendingInstall;
        }
        return { added: Object.keys(servers), removed: [], errors: {} };
      };
      const nativeRunner = makeClaudeAgentSdkQueryRunner({
        allocateSessionId: Effect.succeed("allocated-session"),
        requireMcpServerRegistration: true,
        query: () => Effect.succeed(query),
        forkSession: async () => ({ sessionId: "forked-session" }),
        subagentLaunchToolUseId: async () => null,
      });
      const session = yield* nativeRunner.open({
        ...identity,
        options: { ...queryOptions, mcpServers: mcp("ready", "https://mcp.invalid/ready") },
      });
      const configureMcp = session.configureMcp;
      if (configureMcp === undefined) throw new Error("native MCP control is unavailable");
      const controller = new AbortController();
      const installing = yield* configureMcp(
        mcp("pending", "https://mcp.invalid/pending"),
        controller.signal,
      ).pipe(Effect.forkScoped);
      yield* Effect.promise(() => installationStarted);
      const prompt = yield* Effect.exit(
        session.offer(makeClaudeUserMessage({ text: "must wait" })),
      );
      assert.isTrue(Exit.isFailure(prompt));
      controller.abort(new Error("turn access ended"));
      const result = yield* Effect.exit(Fiber.join(installing));
      assert.isTrue(Exit.isFailure(result));
      assert.isTrue(closed);
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(session.offer(makeClaudeUserMessage({ text: "failed" }))),
        ),
      );
      finish({ added: [], removed: [], errors: {} });
      yield* session.close;
    }).pipe(Effect.scoped),
  );

  it.effect("leaves existing provider sessions warning-only unless a host opts in", () =>
    Effect.gen(function* () {
      const query = queryFixture();
      query.setMcpServers = async (servers) => ({
        added: [],
        removed: [],
        errors: { [Object.keys(servers)[0]!]: "ignored by existing policy" },
      });
      const ordinaryRunner = makeClaudeAgentSdkQueryRunner({
        allocateSessionId: Effect.succeed("allocated-session"),
        query: () => Effect.succeed(query),
        forkSession: async () => ({ sessionId: "forked-session" }),
        subagentLaunchToolUseId: async () => null,
      });
      const session = yield* ordinaryRunner.open({
        ...identity,
        options: { ...queryOptions, mcpServers: mcp("legacy", "https://mcp.invalid/legacy") },
      });
      yield* session.offer(makeClaudeUserMessage({ text: "legacy behavior" }));
      yield* session.close;
    }),
  );
});
