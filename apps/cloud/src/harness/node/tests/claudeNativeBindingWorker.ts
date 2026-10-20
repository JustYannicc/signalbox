import * as NodeAssert from "node:assert/strict";
import * as NodeUtil from "node:util";
import { ThreadId } from "@t3tools/contracts";
import type { ProviderAdapterV2TurnInput } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import { makeClaudeNativeHostBinding } from "../../ClaudeNativeHostBinding.ts";
import { nativeTurnThreadLoad, type NativeThreadLoad } from "../../HarnessThreadLoad.ts";
import type {
  PreparedClaudeSdk,
  SdkSpawnOptions,
  SdkSpawnedProcess,
} from "../../ClaudeIsolateAdapter.ts";
import type { ClaudeAgentSdkMcpServers } from "@signalbox/provider-claude/ClaudeQueryRunner";
import type { ClaudeSdkQuery } from "@signalbox/provider-claude/ClaudeSdkQueryRunner";
import { readinessFixture } from "./claudeReadinessFixture.ts";
import * as NodeWorkerThreads from "node:worker_threads";

type SDKUserMessage = Parameters<
  import("@signalbox/provider-claude/ClaudeQueryRunner").ClaudeAgentSdkQuerySession["offer"]
>[0];
type SDKMessage = Exclude<Awaited<ReturnType<ClaudeSdkQuery["next"]>>["value"], void>;

function sdkQuery(
  prompt: AsyncIterable<SDKUserMessage>,
  child: SdkSpawnedProcess,
  installs: ClaudeAgentSdkMcpServers[],
  order: string[],
  offered: (message: SDKUserMessage) => void,
): ClaudeSdkQuery {
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  void (async () => {
    const first = await prompt[Symbol.asyncIterator]().next();
    NodeAssert.equal(first.done, false);
    if (first.value !== undefined) {
      order.push("prompt.offer");
      offered(first.value);
    }
  })();
  async function* messages(): AsyncGenerator<SDKMessage> {
    await closed;
    yield* [];
  }
  return Object.assign(messages(), {
    close: () => {
      finish();
      child.kill("SIGTERM");
    },
    setMcpServers: async (servers: ClaudeAgentSdkMcpServers) => {
      order.push("setMcpServers");
      installs.push(servers);
      return { added: Object.keys(servers), removed: [], errors: {} };
    },
    setModel: async (_model: string) => {},
    applyFlagSettings: async (_settings: Parameters<ClaudeSdkQuery["applyFlagSettings"]>[0]) => {},
    setPermissionMode: async (_mode: Parameters<ClaudeSdkQuery["setPermissionMode"]>[0]) => {},
    stopTask: async (_taskId: string) => {},
    backgroundTasks: async (_toolUseId: string) => true,
    interrupt: async () => undefined,
  }) satisfies ClaudeSdkQuery;
}

function coldSetup() {
  const f = readinessFixture();
  return Effect.scoped(
    Effect.gen(function* () {
      const services = yield* f.services;
      const origin = "https://harness-mcp.invalid";
      const routeRequests: string[] = [];
      const modelRequests: string[] = [];
      const installs: ClaudeAgentSdkMcpServers[] = [];
      const order: string[] = [];
      let fetchedMcp = "";
      let fetchedModel = "";
      let queryOptions: unknown;
      let resolvePrompt!: (message: SDKUserMessage) => void;
      const offeredPrompt = new Promise<SDKUserMessage>((resolve) => {
        resolvePrompt = resolve;
      });
      const sdk: PreparedClaudeSdk = {
        query: ({ prompt, options }) => {
          order.push("sdk.query");
          queryOptions = options;
          const spawn = options.spawnClaudeCodeProcess;
          if (spawn === undefined) throw new Error("SDK launch callback is missing");
          const child = spawn({
            command: "/runtime/claude",
            args: ["--output-format", "stream-json", "--input-format", "stream-json"],
            cwd: "/work",
            env: { HOME: "/home/test", PATH: "/bin" },
            signal: new AbortController().signal,
          } satisfies SdkSpawnOptions);
          order.push("spawnClaudeCodeProcess");
          return sdkQuery(prompt, child, installs, order, resolvePrompt);
        },
        forkSession: async (sessionId) => ({ sessionId }),
        getSubagentMessages: async () => [],
      };
      const binding = makeClaudeNativeHostBinding({
        process: { ...f.input, computer: services.computer },
        adapter: services.adapter,
        mcpSessions: services.mcpSessions,
        loadSdk: async () => {
          // @effect-diagnostics-next-line globalFetch:off - Verify the fetch installed by the guest personality.
          const mcpResponse = await globalThis.fetch(`${origin}/thread/epoch-1/executor`);
          fetchedMcp = await mcpResponse.text();
          // @effect-diagnostics-next-line globalFetch:off - Verify fallback through the same installed fetch.
          const modelResponse = await globalThis.fetch("https://model.invalid/request");
          fetchedModel = await modelResponse.text();
          return sdk;
        },
        mcp: {
          origin,
          fetch: async (request) => {
            routeRequests.push(request.url);
            return new Response("canonical-mcp");
          },
        },
      });
      const openInput = {
        release: {
          harness: "claude-code" as const,
          version: "test",
          manifestSha256: "binding-test",
          modules: { entry: { bytes: 1, sha256: "entry" } },
        },
        session: services.session,
        computer: services.computer,
        modelTransport: async (request: Request) => {
          modelRequests.push(request.url);
          return new Response("ordinary-model");
        },
      };
      const runtime = yield* binding.factory.open(openInput);
      const load = nativeTurnThreadLoad(
        services.turn,
        services.session,
        services.session.providerSessionId,
      );
      const controller = new AbortController();
      yield* binding.configureMcp(
        {
          epoch: 1,
          servers: { executor: { url: `${origin}/thread/epoch-1/executor` } },
        },
        controller.signal,
        load,
      );
      const providerThread =
        load.method === "ensureThread"
          ? yield* runtime.ensureThread(load.input)
          : yield* runtime.resumeThread(load.input);
      const turn: ProviderAdapterV2TurnInput = {
        appThread: services.turn.appThread,
        threadId: services.turn.threadId,
        runId: services.turn.runId,
        runOrdinal: services.turn.runOrdinal,
        providerTurnOrdinal: services.turn.providerTurnOrdinal,
        attemptId: services.turn.attemptId,
        rootNodeId: services.turn.rootNodeId,
        providerThread,
        message: services.turn.message,
        modelSelection: services.turn.modelSelection,
        runtimePolicy: services.session.runtimePolicy,
      };
      yield* runtime.startTurn(turn);
      const offered = yield* Effect.promise(() => offeredPrompt);

      NodeAssert.equal(fetchedMcp, "canonical-mcp");
      NodeAssert.equal(fetchedModel, "ordinary-model");
      NodeAssert.deepEqual(routeRequests, [`${origin}/thread/epoch-1/executor`]);
      NodeAssert.deepEqual(modelRequests, ["https://model.invalid/request"]);
      NodeAssert.deepEqual(order, [
        "sdk.query",
        "spawnClaudeCodeProcess",
        "setMcpServers",
        "prompt.offer",
      ]);
      NodeAssert.equal(installs.length, 1);
      NodeAssert.deepEqual(Object.keys(installs[0] ?? {}), ["executor"]);
      const installed = installs[0]?.executor;
      NodeAssert.ok(installed !== undefined && "url" in installed);
      NodeAssert.equal(installed.url, `${origin}/thread/epoch-1/executor`);
      const content = offered.message.content;
      const text =
        typeof content === "string"
          ? content
          : content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("");
      NodeAssert.equal(text, services.turn.message.text);
      NodeAssert.ok(
        queryOptions !== undefined && queryOptions !== null && typeof queryOptions === "object",
      );
      NodeAssert.equal(Object.hasOwn(queryOptions, "mcpServers"), false);
      yield* binding.configureMcp({ epoch: 2, servers: {} }, controller.signal, {
        method: "resumeThread",
        input: {
          providerThread,
          threadId: services.session.threadId,
          modelSelection: services.session.modelSelection,
          runtimePolicy: services.session.runtimePolicy,
        },
      });
      NodeAssert.deepEqual(installs, [
        { executor: { type: "http", url: `${origin}/thread/epoch-1/executor` } },
        {},
      ]);
      NodeAssert.equal(order.filter((value) => value === "prompt.offer").length, 1);
    }).pipe(Effect.ensuring(Effect.promise(() => f.close()))),
  );
}

function resumeSetup() {
  const f = readinessFixture();
  return Effect.scoped(
    Effect.gen(function* () {
      const services = yield* f.services;
      const binding = makeClaudeNativeHostBinding({
        process: { ...f.input, computer: services.computer },
        adapter: services.adapter,
        mcpSessions: services.mcpSessions,
        loadSdk: async () => ({
          query: () => {
            throw new Error("A turn query must not open during native thread handoff.");
          },
          forkSession: async (sessionId) => ({ sessionId }),
          getSubagentMessages: async () => [],
        }),
        mcp: {
          origin: "https://harness-mcp.invalid",
          fetch: async () => new Response("unused"),
        },
      });
      const runtime = yield* binding.factory.open({
        release: {
          harness: "claude-code",
          version: "test",
          manifestSha256: "resume-binding-test",
          modules: { entry: { bytes: 1, sha256: "entry" } },
        },
        session: services.session,
        computer: services.computer,
        modelTransport: async () => new Response("unused"),
      });
      const secondOpen = yield* Effect.exit(
        binding.factory.open({
          release: {
            harness: "claude-code",
            version: "test",
            manifestSha256: "second-open",
            modules: { entry: { bytes: 1, sha256: "entry" } },
          },
          session: { ...services.session, threadId: ThreadId.make("other-thread") },
          computer: services.computer,
          modelTransport: async () => new Response("unused"),
        }),
      );
      NodeAssert.equal(secondOpen._tag, "Failure");
      const requestedThread = {
        ...services.turn.providerThread,
        nativeThreadRef: {
          driver: services.turn.providerThread.driver,
          nativeId: "resumed-native-thread",
          strength: "strong" as const,
        },
      };
      const load: NativeThreadLoad = {
        method: "resumeThread",
        input: {
          providerThread: requestedThread,
          threadId: services.session.threadId,
          modelSelection: services.session.modelSelection,
          runtimePolicy: services.session.runtimePolicy,
        },
      };
      yield* binding.configureMcp({ epoch: 1, servers: {} }, new AbortController().signal, load);
      const staleEpoch = yield* Effect.exit(
        binding.configureMcp({ epoch: 1, servers: {} }, new AbortController().signal, load),
      );
      NodeAssert.equal(staleEpoch._tag, "Failure");

      const handedOff = yield* runtime.resumeThread(load.input);
      NodeAssert.equal(handedOff.nativeThreadRef?.nativeId, "resumed-native-thread");
      NodeAssert.equal(handedOff.nativeThreadRef?.strength, "strong");
      NodeAssert.equal(handedOff.providerSessionId, services.session.providerSessionId);
      NodeAssert.equal(handedOff.appThreadId, services.session.threadId);
      const secondHandoff = yield* Effect.exit(runtime.resumeThread(load.input));
      NodeAssert.equal(secondHandoff._tag, "Failure");
    }).pipe(Effect.ensuring(Effect.promise(() => f.close()))),
  );
}

const run =
  NodeWorkerThreads.workerData === "cold"
    ? coldSetup
    : NodeWorkerThreads.workerData === "resume"
      ? resumeSetup
      : undefined;
if (run === undefined || NodeWorkerThreads.parentPort === null)
  throw new Error("Invalid native binding test case.");
const port = NodeWorkerThreads.parentPort;
void Effect.runPromise(run()).then(
  () => {
    port.postMessage({ ok: true });
    port.close();
  },
  (cause: unknown) => {
    port.postMessage({
      ok: false,
      error: NodeUtil.inspect(cause, { depth: 12 }),
    });
    port.close();
  },
);
