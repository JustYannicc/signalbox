import { vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { CodexHarnessProcess, CodexHarnessProcessOptions } from "../../CodexHarnessProcess.ts";
import { makeCodexNativeHostBinding } from "../../CodexNativeHostBinding.ts";
import { createHarnessRequestFacet, HarnessRequestFacetError } from "../../HarnessRequestFacet.ts";
import type { NativeMcpConfiguration, NativeThreadLoad } from "../../HarnessSessionHost.ts";
import { createHarnessRequestTurn } from "../../HarnessRequestTurn.ts";
import { fixture as kernelFixture } from "../../codex/tests/fixture.ts";
import {
  adapterOptions,
  processFixture,
  readyLine,
} from "../../codex/tests/preinitializedFixture.ts";
import { echoEngine } from "../../codex/tests/wasm.ts";
import {
  controlKey,
  fixture as runStoreFixture,
  initial,
  supervisor,
  runId,
} from "../../runStore/tests/fixture.ts";
import { install, requestPublisher } from "../../runStore/tests/requestFixture.ts";
import { requestFixture } from "./fixture.ts";

const launch = vi.hoisted(() =>
  vi.fn<(input: CodexHarnessProcessOptions) => Promise<CodexHarnessProcess>>(),
);
vi.mock("../../CodexHarnessProcess.ts", () => ({ startCodexHarnessProcess: launch }));

export const layer = Layer.mergeAll(NodeServices.layer, IdAllocator.layer);
const encodeFrame = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
export const isNativeTurnStart = Schema.is(
  Schema.Struct({
    type: Schema.Literal("provider_turn.updated"),
    providerTurn: Schema.Struct({
      status: Schema.Literal("running"),
      nativeTurnRef: Schema.Struct({
        nativeId: Schema.Literal("preinitialized-turn"),
        strength: Schema.Literal("strong"),
      }),
    }),
  }),
);

export const integration = (
  setup: "thread/start" | "thread/resume",
  beforeReply: (method: string) => Promise<void>,
) =>
  Effect.gen(function* () {
    const driver = yield* requestFixture;
    const database = runStoreFixture();
    const client = database.open();
    const call = (command: unknown) =>
      Effect.tryPromise({
        try: () => client.call(command),
        catch: (cause) => new HarnessRequestFacetError("Integration store failed", { cause }),
      });
    yield* call(initial);
    yield* call({
      type: "request.mode",
      runId,
      controlKey,
      requestId: "request-mode",
      checkpoint: driver.initial,
    });
    yield* call(install());

    const context = kernelFixture(echoEngine(), driver.instance.adapter.input.session.threadId);
    const peer = processFixture(beforeReply);
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await peer.process.abort();
        await context.close();
      }),
    );
    (yield* Effect.promise(() => peer.output)).enqueue(new TextEncoder().encode(readyLine));
    launch.mockReset();
    launch.mockResolvedValue(peer.process);
    const release = yield* Effect.promise(() => driver.f.codexRelease());
    const adapter = yield* adapterOptions();
    let bindingConstructions = 0;
    const configurations: NativeMcpConfiguration[] = [];
    const configurationLoads: NativeThreadLoad[] = [];
    const bindingCalls: string[] = [];
    const providerStartInputs: Array<Record<string, unknown>> = [];
    let routedModelTransport: ((request: Request) => Promise<Response>) | undefined;
    driver.setHost({
      release,
      buildRuntime: ({ harness }) =>
        Effect.sync(() => {
          bindingConstructions++;
          routedModelTransport = harness.modelTransport;
          const binding = makeCodexNativeHostBinding({
            process: { ...context.options, computer: harness.computer },
            adapter,
            modelOrigins: ["https://harness-mcp.invalid"],
            mcpSessions: {
              set: () => Effect.die("Unexpected app MCP fallback"),
              read: () => Effect.succeed(undefined),
              clear: () => Effect.die("Unexpected app MCP fallback"),
            },
          });
          return {
            ...binding,
            factory: {
              ...binding.factory,
              open: (input, reporter) =>
                binding.factory.open(input, reporter).pipe(
                  Effect.map((runtime) => ({
                    ...runtime,
                    ensureThread: (threadInput) => {
                      bindingCalls.push("ensureThread");
                      return runtime.ensureThread(threadInput);
                    },
                    resumeThread: (threadInput) => {
                      bindingCalls.push("resumeThread");
                      return runtime.resumeThread(threadInput);
                    },
                    startTurn: (turnInput) => {
                      bindingCalls.push("startTurn");
                      providerStartInputs.push({
                        providerThreadId: turnInput.providerThread.id,
                        nativeThreadId: turnInput.providerThread.nativeThreadRef?.nativeId,
                        providerSessionId: turnInput.providerThread.providerSessionId,
                        providerInstanceId: turnInput.providerThread.providerInstanceId,
                        appThreadId: turnInput.providerThread.appThreadId,
                        modelSelection: turnInput.modelSelection,
                        runtimePolicy: turnInput.runtimePolicy,
                      });
                      return runtime.startTurn(turnInput);
                    },
                  })),
                ),
            },
            configureMcp: (configuration, signal, load) => {
              configurations.push(configuration);
              configurationLoads.push(load);
              return binding.configureMcp(configuration, signal, load);
            },
          };
        }),
    });

    const requestId = "native-load-turn";
    const turn =
      setup === "thread/start"
        ? driver.instance.adapter.turn
        : {
            ...driver.instance.adapter.turn,
            providerThread: {
              ...driver.instance.adapter.turn.providerThread,
              nativeThreadRef: {
                driver: driver.instance.adapter.runtime.driver,
                nativeId: "preinitialized-native-thread",
                strength: "strong" as const,
              },
            },
          };
    const input = yield* driver.input("native-load-input", turn);
    yield* call({ type: "request.offer", runId, supervisor, request: { requestId, input } });
    const facet = yield* createHarnessRequestFacet({
      runId,
      facetNonce: requestPublisher().facetNonce,
      store: { execute: (command) => client.call(command) },
      verify: driver.verify,
      open: createHarnessRequestTurn(driver.options),
    });
    yield* Effect.addFinalizer(() => facet.dispose);
    const run = facet.run({ publisher: requestPublisher(), requestId });
    return {
      driver,
      call,
      facet,
      peer,
      run,
      configurations,
      configurationLoads,
      bindingCalls,
      providerStartInputs,
      get bindingConstructions() {
        return bindingConstructions;
      },
      get launchCount() {
        return launch.mock.calls.length;
      },
      modelTransport: (request: Request) => {
        if (routedModelTransport === undefined)
          throw new Error("Codex model transport is unavailable");
        return routedModelTransport(request);
      },
    };
  });

export const failedStartRows = (driver: Effect.Success<typeof requestFixture>) => {
  const tables = driver.f.handle.rows(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'harness_host_failures'",
  );
  return tables.length === 0
    ? []
    : driver.f.handle.rows("SELECT boot_attempt_id, run_id, error_json FROM harness_host_failures");
};

export const completeNativeTurn = (peer: ReturnType<typeof processFixture>, id: string) =>
  Effect.promise(() => peer.output).pipe(
    Effect.flatMap((output) =>
      Effect.sync(() =>
        output.enqueue(
          new TextEncoder().encode(
            encodeFrame({
              method: "turn/completed",
              params: {
                threadId: "preinitialized-native-thread",
                turn: { id, status: "completed", items: [], error: null },
              },
            }) + "\n",
          ),
        ),
      ),
    ),
  );
