import * as NodeAssert from "node:assert/strict";
import * as NodeUtil from "node:util";
import { ThreadId } from "@t3tools/contracts";
import type { ProviderAdapterV2TurnInput } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Cause from "effect/Cause";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import { makeClaudeNativeHostBinding } from "../../ClaudeNativeHostBinding.ts";
import {
  createClaudeToolObservation,
  type ClaudeToolHookInput,
} from "../../ClaudeToolObservation.ts";
import { nativeTurnThreadLoad, type NativeThreadLoad } from "../../HarnessThreadLoad.ts";
import type { PreparedClaudeSdk, SdkSpawnOptions } from "../../ClaudeIsolateAdapter.ts";
import type { ClaudeAgentSdkMcpServers } from "@signalbox/provider-claude/ClaudeQueryRunner";
import type {
  ClaudeSdkQuery,
  ClaudeSdkQueryPreCleanupDiagnostic,
} from "@signalbox/provider-claude/ClaudeSdkQueryRunner";
import {
  assertPreparedAssets,
  preparedAssetsFixture,
  latinAsset,
} from "./preparedAssetsFixture.ts";
import type { GuestModule } from "./fixture.ts";
import { readinessFixture } from "./claudeReadinessFixture.ts";
import * as NodeWorkerThreads from "node:worker_threads";
import { createNodeRuntimeCompatibility } from "../../../isolate/NodeRuntimeCompatibility.ts";

import { sdkQuery, successfulResult, type SDKUserMessage } from "./claudeSdkQueryFixture.ts";

function coldSetup(
  override?:
    | "prepared"
    | "both"
    | "diagnostic"
    | "observation"
    | "compatibility"
    | "result"
    | "result-failure"
    | "end-failure",
  verified?: () => void,
) {
  const f = readinessFixture();
  return Effect.scoped(
    Effect.gen(function* () {
      const services = yield* f.services;
      const { loaded } = yield* Effect.promise(preparedAssetsFixture);
      const origin = "https://harness-mcp.invalid";
      const routeRequests: string[] = [];
      const modelRequests: string[] = [];
      const installs: ClaudeAgentSdkMcpServers[] = [];
      const order: string[] = [];
      const hasPreparedOverride = override === "prepared" || override === "both";
      const diagnosticCase = override === "diagnostic";
      const compatibilityCase = override === "compatibility";
      const resultCase =
        override === "result" || override === "result-failure" || override === "end-failure";
      const failureCase =
        compatibilityCase || override === "result-failure" || override === "end-failure";
      let reportRuntimeFailure: ((error: unknown) => void) | undefined;
      let yieldedResult = false;
      const initializationFailure = new Error("host SDK initialization failure");
      const diagnostics: ClaudeSdkQueryPreCleanupDiagnostic[] = [];
      const childFailure = Promise.withResolvers<unknown>();
      let fetchedMcp = "";
      let fetchedModel = "";
      let queryOptions: unknown;
      const observedHooks: string[] = [];
      const hookReturns: Promise<unknown>[] = [];
      const toolObservation = createClaudeToolObservation((event) => {
        observedHooks.push(event.input.hook_event_name + ":" + event.toolUseId);
      });
      let resolvePrompt!: (message: SDKUserMessage) => void;
      const offeredPrompt = new Promise<SDKUserMessage>((resolve) => {
        resolvePrompt = resolve;
      });
      const sdk: PreparedClaudeSdk = {
        query: ({ prompt, options }) => {
          order.push("sdk.query");
          queryOptions = options;
          if (override === "observation") {
            const base = {
              session_id: "sdk-session",
              transcript_path: "/work/transcript",
              cwd: "/work",
              tool_name: "Bash",
              tool_use_id: "call",
              tool_input: { command: "short" },
            };
            const payloads: ClaudeToolHookInput[] = [
              { ...base, hook_event_name: "PreToolUse" },
              {
                ...base,
                hook_event_name: "PostToolUse",
                tool_response: { stdout: "exact", exitCode: null },
              },
              { ...base, hook_event_name: "PostToolUseFailure", error: "original error" },
            ];
            for (const payload of payloads) {
              const registrations = options.hooks?.[payload.hook_event_name];
              NodeAssert.equal(registrations?.length, 1);
              const registration = registrations![0]!;
              NodeAssert.equal(Object.hasOwn(registration, "matcher"), false);
              hookReturns.push(
                registration.hooks[0]!(payload, "call", { signal: new AbortController().signal }),
              );
            }
          } else NodeAssert.equal(options.hooks, undefined);
          const spawn = options.spawnClaudeCodeProcess;
          if (spawn === undefined) throw new Error("SDK launch callback is missing");
          const child = spawn({
            command: "/runtime/claude",
            args: ["--output-format", "stream-json", "--input-format", "stream-json"],
            cwd: "/work",
            env: { HOME: "/home/test", PATH: "/bin" },
            signal: new AbortController().signal,
          } satisfies SdkSpawnOptions);
          if (failureCase) child.on("error", (error) => childFailure.resolve(error));
          order.push("spawnClaudeCodeProcess");
          return sdkQuery(
            prompt,
            child,
            installs,
            order,
            resolvePrompt,
            async () => {
              order.push("initializationResult");
              if (diagnosticCase) throw initializationFailure;
              return {} as Awaited<ReturnType<ClaudeSdkQuery["initializationResult"]>>;
            },
            !diagnosticCase && !compatibilityCase,
            !resultCase
              ? undefined
              : async function* () {
                  const message = await offeredPrompt;
                  if (failureCase) {
                    if (reportRuntimeFailure === undefined) throw new Error("No runtime reporter");
                    try {
                      throw Object.assign(new Error("caught unsupported result schema"), {
                        code: "AJV_SCHEMA_NOT_PRECOMPILED",
                      });
                    } catch (error) {
                      reportRuntimeFailure(error);
                    }
                  }
                  if (override !== "end-failure") {
                    yieldedResult = true;
                    yield successfulResult(message);
                  }
                },
          );
        },
        forkSession: async (sessionId) => ({ sessionId }),
        getSubagentMessages: async () => [],
      };
      const binding = makeClaudeNativeHostBinding({
        ...(override === "observation" ? { toolObservation } : {}),
        process: {
          ...f.input,
          computer: services.computer,
          ...(!compatibilityCase && !resultCase
            ? {}
            : {
                loadRelease: async (bridge, signal) => {
                  const release = await f.input.loadRelease(bridge, signal);
                  if (release === null || typeof release !== "object")
                    throw new Error("No fixture release");
                  const launch: unknown = Reflect.get(release, "launch");
                  const report: unknown = Reflect.get(
                    bridge.require("worker_threads"),
                    "reportRuntimeFailure",
                  );
                  if (typeof launch !== "function" || typeof report !== "function")
                    throw new Error("No compatibility capability");
                  if (resultCase) {
                    // Exercise the release-export latch independently of the process failure signal.
                    const realm = createNodeRuntimeCompatibility({});
                    const realmReport: unknown = Reflect.get(realm.module, "reportRuntimeFailure");
                    if (typeof realmReport !== "function") throw new Error("No realm reporter");
                    reportRuntimeFailure = (error) => {
                      realmReport(error);
                    };
                    return {
                      launch: () => Reflect.apply(launch, release, []),
                      assertRuntimeCompatibility: async () => {
                        try {
                          await realm.assert();
                        } catch (error) {
                          order.push("compatibility.reject");
                          throw error;
                        }
                      },
                    };
                  }
                  reportRuntimeFailure = (error) => {
                    report(error);
                  };
                  return {
                    launch() {
                      Reflect.apply(launch, release, []);
                      try {
                        throw Object.assign(new Error("caught unsupported startup schema"), {
                          code: "AJV_SCHEMA_NOT_PRECOMPILED",
                        });
                      } catch (error) {
                        report(error);
                      }
                    },
                  };
                },
              }),
          ...(!hasPreparedOverride
            ? {}
            : {
                prepared: (specifier: string) => {
                  if (specifier === latinAsset) return "caller text";
                  throw new Error("Caller refused asset");
                },
              }),
          ...(override !== "both" ? {} : { resolvePrepared: () => "/caller/text" }),
        },
        adapter: services.adapter,
        mcpSessions: services.mcpSessions,
        loadSdk: async (bridge) => {
          const module = bridge.require("node:module") as GuestModule;
          if (!hasPreparedOverride) assertPreparedAssets(module);
          else {
            const require = module.createRequire("/entry.js");
            NodeAssert.equal(require(latinAsset), "caller text");
            NodeAssert.throws(() => require("/embedded/utf16.txt"), /Caller refused asset/);
            if (override === "both") NodeAssert.equal(require.resolve(latinAsset), "/caller/text");
            else
              NodeAssert.throws(() => require.resolve(latinAsset), {
                code: "ERR_NODE_PREPARED_MODULE_UNAVAILABLE",
              });
          }
          if (!diagnosticCase) {
            // @effect-diagnostics-next-line globalFetch:off - Verify the fetch installed by the guest personality.
            const mcpResponse = await globalThis.fetch(`${origin}/thread/epoch-1/executor`);
            fetchedMcp = await mcpResponse.text();
            // @effect-diagnostics-next-line globalFetch:off - Verify fallback through the same installed fetch.
            const modelResponse = await globalThis.fetch("https://model.invalid/request");
            fetchedModel = await modelResponse.text();
          }
          return sdk;
        },
        mcp: {
          origin,
          fetch: async (request) => {
            routeRequests.push(request.url);
            return new Response("canonical-mcp");
          },
        },
        ...(diagnosticCase
          ? {
              onQueryPreCleanupDiagnostic: (diagnostic: ClaudeSdkQueryPreCleanupDiagnostic) => {
                diagnostics.push(diagnostic);
                order.push(`precleanup:${diagnostic.phase}`);
              },
            }
          : {}),
      });
      const openInput = {
        loadedRelease: loaded,
        release: loaded.plan.release,
        session: services.session,
        computer: services.computer,
        modelTransport: async (request: Request) => {
          modelRequests.push(request.url);
          return new Response("ordinary-model");
        },
      };
      const load = nativeTurnThreadLoad(
        services.turn,
        services.session,
        services.session.providerSessionId,
      );
      const controller = new AbortController();
      const runtime = yield* binding.factory.open(openInput, {
        releaseModuleOmitted: () => undefined,
      });
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
      const duplicateHandoff = yield* Effect.exit(
        load.method === "ensureThread"
          ? runtime.ensureThread(load.input)
          : runtime.resumeThread(load.input),
      );
      NodeAssert.equal(duplicateHandoff._tag, "Failure");
      const changedIdentity = yield* Effect.exit(
        runtime.startTurn({
          ...turn,
          providerThread: {
            ...providerThread,
            nativeThreadRef: {
              driver: providerThread.driver,
              nativeId: "another-native-thread",
              strength: "strong",
            },
          },
        }),
      );
      NodeAssert.equal(changedIdentity._tag, "Failure");
      const changedSettings = yield* Effect.exit(
        runtime.startTurn({
          ...turn,
          modelSelection: { ...turn.modelSelection, model: "another-model" },
        }),
      );
      NodeAssert.equal(changedSettings._tag, "Failure");
      NodeAssert.equal(order.includes("sdk.query"), false);
      if (compatibilityCase) {
        const start = yield* Effect.exit(runtime.startTurn(turn));
        NodeAssert.equal(start._tag, "Failure");
        if (start._tag === "Failure")
          NodeAssert.match(Cause.pretty(start.cause), /caught unsupported startup schema/);
        NodeAssert.match(
          NodeUtil.inspect(yield* Effect.promise(() => childFailure.promise)),
          /caught unsupported startup schema/,
        );
        NodeAssert.equal(order.includes("prompt.offer"), false);
        verified?.();
        return;
      }
      if (diagnosticCase) {
        const start = yield* Effect.exit(runtime.startTurn(turn));
        NodeAssert.equal(start._tag, "Failure");
        NodeAssert.deepEqual(order, [
          "sdk.query",
          "spawnClaudeCodeProcess",
          "initializationResult",
          "precleanup:initialization",
          "query.close",
        ]);
        NodeAssert.equal(installs.length, 0);
        NodeAssert.equal(diagnostics.length, 1);
        NodeAssert.equal(diagnostics[0]?.phase, "initialization");
        NodeAssert.ok(diagnostics[0]?.mcpSignal.present);
        NodeAssert.deepEqual(routeRequests, []);
        NodeAssert.deepEqual(modelRequests, []);
        if (diagnostics[0]?.mcpSignal.present) {
          NodeAssert.equal(diagnostics[0].mcpSignal.aborted, false);
        }
        NodeAssert.match(Cause.pretty(diagnostics[0]!.cause), /host SDK initialization failure/);
        return;
      }
      yield* runtime.startTurn(turn);
      const offered = yield* Effect.promise(() => offeredPrompt);
      if (resultCase) {
        const terminal = yield* Stream.runHead(
          runtime.events.pipe(Stream.filter((event) => event.type === "turn.terminal")),
        );
        NodeAssert.equal(terminal._tag, "Some");
        if (terminal._tag === "Some" && terminal.value.type === "turn.terminal") {
          NodeAssert.equal(terminal.value.status, failureCase ? "failed" : "completed");
        }
        NodeAssert.equal(yieldedResult, override !== "end-failure");
        if (failureCase) {
          const rejected = order.indexOf("compatibility.reject");
          const closed = order.indexOf("query.close");
          NodeAssert.ok(
            rejected >= 0 && (closed === -1 || rejected < closed),
            "The SDK must reject the runtime compatibility failure before cleanup",
          );
        }
        verified?.();
        return;
      }

      NodeAssert.equal(fetchedMcp, "canonical-mcp");
      NodeAssert.equal(fetchedModel, "ordinary-model");
      NodeAssert.deepEqual(routeRequests, [`${origin}/thread/epoch-1/executor`]);
      NodeAssert.deepEqual(modelRequests, ["https://model.invalid/request"]);
      NodeAssert.deepEqual(order, [
        "sdk.query",
        "spawnClaudeCodeProcess",
        "initializationResult",
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
      if (override === "observation") {
        const returns = yield* Effect.promise(() => Promise.all(hookReturns));
        yield* Effect.promise(() => toolObservation.drain());
        NodeAssert.deepEqual(returns, [{}, {}, {}]);
        NodeAssert.deepEqual(observedHooks, [
          "PreToolUse:call",
          "PostToolUse:call",
          "PostToolUseFailure:call",
        ]);
        NodeAssert.deepEqual(toolObservation.snapshot().failures, []);
        NodeAssert.equal(toolObservation.snapshot().measurements.length, 3);
      }
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
      const runtime = yield* binding.factory.open(
        {
          release: {
            harness: "claude-code",
            version: "test",
            manifestSha256: "resume-binding-test",
            modules: { entry: { bytes: 1, sha256: "entry" } },
          },
          session: services.session,
          computer: services.computer,
          modelTransport: async () => new Response("unused"),
        },
        { releaseModuleOmitted: () => undefined },
      );
      const secondOpen = yield* Effect.exit(
        binding.factory.open(
          {
            release: {
              harness: "claude-code",
              version: "test",
              manifestSha256: "second-open",
              modules: { entry: { bytes: 1, sha256: "entry" } },
            },
            session: { ...services.session, threadId: ThreadId.make("other-thread") },
            computer: services.computer,
            modelTransport: async () => new Response("unused"),
          },
          { releaseModuleOmitted: () => undefined },
        ),
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

const caseName: unknown = NodeWorkerThreads.workerData;
const run =
  caseName === "compatibility" || caseName === "result-failure" || caseName === "end-failure"
    ? () => {
        let verified = false;
        return Effect.exit(
          coldSetup(caseName, () => {
            verified = true;
          }),
        ).pipe(
          Effect.map((exit) => {
            NodeAssert.ok(
              verified,
              exit._tag === "Failure"
                ? Cause.pretty(exit.cause)
                : "Expected failure assertions did not run",
            );
            NodeAssert.equal(exit._tag, "Failure");
            if (exit._tag === "Failure")
              NodeAssert.match(
                Cause.pretty(exit.cause),
                /caught unsupported (startup|result) schema/,
              );
          }),
        );
      }
    : caseName === "prepared" ||
        caseName === "both" ||
        caseName === "diagnostic" ||
        caseName === "observation" ||
        caseName === "result"
      ? () => coldSetup(caseName)
      : caseName === "cold"
        ? coldSetup
        : caseName === "resume"
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
