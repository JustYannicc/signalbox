import * as NodeAssert from "node:assert/strict";
import * as NodeUtil from "node:util";
import * as NodeWorkerThreads from "node:worker_threads";
import * as Effect from "effect/Effect";
import { makeClaudeNativeHostBinding } from "../../ClaudeNativeHostBinding.ts";
import type { PreparedClaudeSdk } from "../../ClaudeIsolateAdapter.ts";
import type { ClaudeSpawnContext } from "../../ClaudeSpawnContext.ts";
import { nativeTurnThreadLoad } from "../../HarnessThreadLoad.ts";
import { readinessFixture } from "./claudeReadinessFixture.ts";
import { preparedAssetsFixture } from "./preparedAssetsFixture.ts";
import { sdkQuery } from "./claudeSdkQueryFixture.ts";

const program = Effect.scoped(
  Effect.gen(function* () {
    const f = readinessFixture();
    yield* Effect.addFinalizer(() => Effect.promise(() => f.close()));
    const services = yield* f.services;
    const { loaded } = yield* Effect.promise(preparedAssetsFixture);
    const stages: string[] = [];
    const contexts: ClaudeSpawnContext[] = [];
    const offered = Promise.withResolvers<void>();
    const stdoutWritten = Promise.withResolvers<void>();
    const stderrWritten = Promise.withResolvers<void>();
    let drainOutput = () => {};
    const sdk: PreparedClaudeSdk = {
      query: ({ prompt, options }) => {
        const spawn = options.spawnClaudeCodeProcess;
        NodeAssert.ok(spawn);
        const child = spawn({
          command: "/runtime/claude",
          args: ["--model", "claude-sonnet-4-6", "--api-key", "binding-private-key"],
          cwd: "/work",
          env: {
            HOME: "/home/test",
            PATH: "/bin",
            LANG: "C.UTF-8",
            API_TOKEN: "binding-private-key",
          },
          signal: new AbortController().signal,
        });
        // The SDK consumer is deliberately attached only after the write-side observations.
        drainOutput = () => child.stdout.resume();
        child.stdin.write(
          `${JSON.stringify({
            type: "control_request",
            request_id: "public-binding-init",
            request: { subtype: "initialize" },
          })}\n`,
        );
        return sdkQuery(
          prompt,
          child,
          [],
          [],
          () => offered.resolve(),
          async () => {
            await stdoutWritten.promise;
            return {
              commands: [],
              agents: [],
              output_style: "default",
              available_output_styles: [],
              models: [],
              account: {},
            };
          },
          true,
        );
      },
      forkSession: async (sessionId) => ({ sessionId }),
      getSubagentMessages: async () => [],
    };
    const binding = makeClaudeNativeHostBinding({
      process: {
        ...f.input,
        computer: services.computer,
        loadRelease: async (bridge) => {
          const process = bridge.require("process");
          NodeAssert.ok(typeof process === "object" && process !== null);
          NodeAssert.deepEqual(Reflect.get(process, "argv"), [
            "/runtime/claude",
            f.input.bun.main,
            "--model",
            "claude-sonnet-4-6",
            "--api-key",
            "binding-private-key",
          ]);
          const stdin: unknown = Reflect.get(process, "stdin");
          const stdout: unknown = Reflect.get(process, "stdout");
          const stderr: unknown = Reflect.get(process, "stderr");
          NodeAssert.ok(typeof stdin === "object" && stdin !== null);
          NodeAssert.ok(typeof stdout === "object" && stdout !== null);
          NodeAssert.ok(typeof stderr === "object" && stderr !== null);
          const on: unknown = Reflect.get(stdin, "on");
          const write: unknown = Reflect.get(stdout, "write");
          const writeError: unknown = Reflect.get(stderr, "write");
          NodeAssert.ok(typeof on === "function");
          NodeAssert.ok(typeof write === "function");
          NodeAssert.ok(typeof writeError === "function");
          let input = "";
          const decoder = new TextDecoder();
          return {
            assertRuntimeCompatibility() {},
            launch() {
              Reflect.apply(on, stdin, [
                "data",
                (bytes: Uint8Array) => {
                  input += decoder.decode(bytes, { stream: true });
                  if (!input.endsWith("\n")) return;
                  const request: unknown = JSON.parse(input);
                  NodeAssert.ok(typeof request === "object" && request !== null);
                  NodeAssert.equal(Reflect.get(request, "request_id"), "public-binding-init");
                  const reply = `${JSON.stringify({
                    type: "control_response",
                    response: {
                      request_id: "public-binding-init",
                      subtype: "success",
                      metadata: "x".repeat(24_000),
                    },
                  })}\n`;
                  Reflect.apply(write, stdout, [reply, () => stdoutWritten.resolve()]);
                  Reflect.apply(writeError, stderr, [
                    "CLI startup stderr\n",
                    () => stderrWritten.resolve(),
                  ]);
                },
              ]);
            },
          };
        },
      },
      adapter: services.adapter,
      mcpSessions: services.mcpSessions,
      loadSdk: async () => sdk,
      mcp: {
        origin: "https://harness-mcp.invalid",
        fetch: async () => new Response(null, { status: 202 }),
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
        turnMilestone: (stage) => stages.push(stage),
        cliSpawnContext: (context) => contexts.push(context),
      },
    );
    const load = nativeTurnThreadLoad(
      services.turn,
      services.session,
      services.session.providerSessionId,
    );
    yield* binding.configureMcp({ epoch: 1, servers: {} }, new AbortController().signal, load);
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
    yield* Effect.promise(() =>
      Promise.all([offered.promise, stdoutWritten.promise, stderrWritten.promise]),
    );
    for (const stage of [
      "cli-spawned",
      "cli-first-stdout-byte",
      "cli-stderr-bytes",
      "control-initialize-sent",
      "control-response-received",
      "runtime-compatibility-checking",
      "runtime-compatibility-confirmed",
    ])
      NodeAssert.equal(stages.filter((value) => value === stage).length, 1, stage);
    NodeAssert.ok(
      stages.indexOf("control-response-received") <
        stages.indexOf("runtime-compatibility-checking"),
    );
    NodeAssert.ok(
      stages.indexOf("runtime-compatibility-confirmed") < stages.indexOf("sdk-initialized"),
    );
    NodeAssert.equal(contexts.length, 1);
    NodeAssert.equal(contexts[0]?.cwd, "/work");
    NodeAssert.deepEqual(contexts[0]?.argv, [
      "/runtime/claude",
      f.input.bun.main,
      "--model",
      "claude-sonnet-4-6",
      "--api-key",
      "[REDACTED]",
    ]);
    NodeAssert.deepEqual(contexts[0]?.env, {
      HOME: "/home/test",
      PATH: "/bin",
      LANG: "C.UTF-8",
      API_TOKEN: "[REDACTED]",
    });
    NodeAssert.equal(contexts[0]?.env.API_TOKEN, "[REDACTED]");
    drainOutput();
  }),
);

const port = NodeWorkerThreads.parentPort;
if (port === null) throw new Error("Initialization test requires its own Node realm.");
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
