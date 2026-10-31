import * as NodeAssert from "node:assert/strict";
import * as NodeUtil from "node:util";
import * as NodeWorkerThreads from "node:worker_threads";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { makeClaudeNativeHostBinding } from "../../ClaudeNativeHostBinding.ts";
import type { PreparedClaudeSdk } from "../../ClaudeIsolateAdapter.ts";
import { nativeTurnThreadLoad } from "../../HarnessThreadLoad.ts";
import type { HarnessTurnStage } from "../../HarnessTurnProgress.ts";
import { readinessFixture } from "./claudeReadinessFixture.ts";
import { preparedAssetsFixture } from "./preparedAssetsFixture.ts";
import { sdkQuery, type SDKMessage } from "./claudeSdkQueryFixture.ts";

const program = Effect.scoped(
  Effect.gen(function* () {
    const f = readinessFixture();
    const services = yield* f.services;
    const { loaded } = yield* Effect.promise(preparedAssetsFixture);
    const stages: HarnessTurnStage[] = [];
    const frame = Promise.withResolvers<SDKMessage>();
    const execution = Promise.withResolvers<void>();
    const offered = Promise.withResolvers<void>();
    const notification = Promise.withResolvers<void>();
    const releaseNotification = Promise.withResolvers<void>();
    let failNotification = true;
    let queryOptions: Parameters<PreparedClaudeSdk["query"]>[0]["options"] | undefined;
    const sdk: PreparedClaudeSdk = {
      query: ({ prompt, options }) => {
        queryOptions = options;
        const child = options.spawnClaudeCodeProcess!({
          command: "/runtime/claude",
          args: [],
          cwd: "/work",
          env: { HOME: "/home/test", PATH: "/bin" },
          signal: new AbortController().signal,
        });
        return sdkQuery(
          prompt,
          child,
          [],
          [],
          () => offered.resolve(),
          async () => ({
            commands: [],
            agents: [],
            output_style: "default",
            available_output_styles: [],
            models: [],
            account: {},
          }),
          true,
          async function* () {
            yield await frame.promise;
          },
        );
      },
      forkSession: async (sessionId) => ({ sessionId }),
      getSubagentMessages: async () => [],
    };
    const origin = "https://harness-mcp.invalid";
    const binding = makeClaudeNativeHostBinding({
      process: { ...f.input, computer: services.computer },
      adapter: services.adapter,
      mcpSessions: services.mcpSessions,
      loadSdk: async () => sdk,
      mcp: {
        origin,
        fetch: async (request) => {
          const message: unknown = await request.json();
          const method =
            typeof message === "object" && message !== null
              ? Reflect.get(message, "method")
              : undefined;
          if (method === "initialize")
            return Response.json({
              jsonrpc: "2.0",
              id: 1,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                serverInfo: { name: "test", version: "1" },
              },
            });
          if (method === "notifications/initialized") {
            notification.resolve();
            await releaseNotification.promise;
            return new Response(null, { status: failNotification ? 500 : 202 });
          }
          return new Response(null, { status: 400 });
        },
      },
    });
    const runtime = yield* binding.factory.open(
      {
        loadedRelease: loaded,
        release: loaded.plan.release,
        session: services.session,
        computer: services.computer,
        modelTransport: async () => new Response("unused"),
      },
      {
        releaseModuleOmitted: () => undefined,
        turnMilestone: (stage) => {
          stages.push(stage);
          if (stage === "tool-call-started") execution.resolve();
        },
      },
    );
    const signal = new AbortController().signal;
    const load = nativeTurnThreadLoad(
      services.turn,
      services.session,
      services.session.providerSessionId,
    );
    yield* binding.configureMcp(
      { epoch: 1, servers: { executor: { url: `${origin}/executor` } } },
      signal,
      load,
    );
    const providerThread =
      load.method === "ensureThread"
        ? yield* runtime.ensureThread(load.input)
        : yield* runtime.resumeThread(load.input);
    yield* runtime.startTurn({
      appThread: services.turn.appThread,
      threadId: services.turn.threadId,
      runId: services.turn.runId,
      runOrdinal: services.turn.runOrdinal,
      providerTurnOrdinal: services.turn.providerTurnOrdinal,
      attemptId: services.turn.attemptId,
      rootNodeId: services.turn.rootNodeId,
      message: services.turn.message,
      modelSelection: services.turn.modelSelection,
      providerThread,
      runtimePolicy: services.session.runtimePolicy,
    });
    yield* Effect.promise(() => offered.promise);
    const options = queryOptions;
    NodeAssert.ok(options);
    const input = {
      session_id: "sdk-session",
      transcript_path: "/work/transcript",
      cwd: "/work",
      tool_name: "AskUserQuestion",
      tool_use_id: "pending",
      tool_input: {},
    };
    yield* Effect.promise(async () => {
      for (const hook of options.hooks?.PreToolUse ?? [])
        for (const callback of hook.hooks)
          await callback({ ...input, hook_event_name: "PreToolUse" }, "pending", { signal });
    });
    NodeAssert.equal(stages.includes("tool-call-started"), false);
    NodeAssert.ok(stages.includes("pre-tool-gate-entered"));
    const permissionAbort = new AbortController();
    const permission = options.canUseTool!(
      "AskUserQuestion",
      {
        questions: [
          {
            question: "Continue?",
            header: "Gate",
            multiSelect: false,
            options: [
              { label: "Yes", description: "Proceed" },
              { label: "No", description: "Stop" },
            ],
          },
        ],
      },
      { signal: permissionAbort.signal, toolUseID: "pending", requestId: "permission" },
    );
    yield* Stream.runHead(
      runtime.events.pipe(Stream.filter((event) => event.type === "runtime_request.updated")),
    );
    NodeAssert.ok(stages.includes("tool-permission-requested"));
    NodeAssert.equal(stages.includes("tool-call-started"), false);
    permissionAbort.abort();
    const denied = yield* Effect.promise(() => permission);
    NodeAssert.ok(denied);
    NodeAssert.equal(denied.behavior, "deny");
    NodeAssert.ok(stages.includes("tool-permission-resolved"));
    NodeAssert.equal(stages.includes("tool-call-started"), false);
    frame.resolve({
      type: "tool_progress",
      tool_use_id: "executing",
      tool_name: "Bash",
      parent_tool_use_id: null,
      elapsed_time_seconds: 30,
      heartbeat: true,
      uuid: "11111111-1111-4111-8111-111111111111",
      session_id: "sdk-session",
    });
    yield* Effect.promise(() => execution.promise);
    yield* Effect.promise(async () => {
      for (const hook of options.hooks?.PostToolUse ?? [])
        for (const callback of hook.hooks)
          await callback(
            {
              ...input,
              tool_name: "Bash",
              tool_use_id: "executing",
              hook_event_name: "PostToolUse",
              tool_response: {},
              duration_ms: 1,
            },
            "executing",
            { signal },
          );
    });
    NodeAssert.ok(stages.includes("tool-call-ended"));

    const send = (method: string, id?: number) => {
      // @effect-diagnostics-next-line globalFetch:off - Exercise the route installed by the real Node personality.
      return globalThis.fetch(`${origin}/executor`, {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", method, ...(id === undefined ? {} : { id }) }),
      });
    };
    yield* Effect.promise(async () => {
      await (await send("initialize", 1)).text();
    });
    NodeAssert.equal(stages.includes("mcp-initialized"), false);
    NodeAssert.ok(stages.includes("mcp-initialize-response"));
    const pendingNotification = send("notifications/initialized");
    yield* Effect.promise(() => notification.promise);
    NodeAssert.equal(stages.includes("mcp-initialized"), false);
    releaseNotification.resolve();
    NodeAssert.equal((yield* Effect.promise(() => pendingNotification)).status, 500);
    NodeAssert.equal(stages.includes("mcp-initialized"), false);
    failNotification = false;
    NodeAssert.equal((yield* Effect.promise(() => send("notifications/initialized"))).status, 202);
    NodeAssert.equal(stages.filter((stage) => stage === "mcp-initialized").length, 1);
  }),
);

const port = NodeWorkerThreads.parentPort;
if (port === null) throw new Error("Progress test requires its own Node realm.");
void Effect.runPromise(program).then(
  () => {
    port.postMessage({ ok: true });
    port.close();
  },
  (cause: unknown) => {
    port.postMessage({ ok: false, error: NodeUtil.inspect(cause, { depth: 12 }) });
    port.close();
  },
);
