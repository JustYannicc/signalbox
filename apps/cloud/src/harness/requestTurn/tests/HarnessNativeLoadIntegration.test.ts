import { describe, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { CodexHarnessProcess, CodexHarnessProcessOptions } from "../../CodexHarnessProcess.ts";
import { makeCodexNativeHostBinding } from "../../CodexNativeHostBinding.ts";
import { createHarnessRequestFacet, HarnessRequestFacetError } from "../../HarnessRequestFacet.ts";
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

const layer = Layer.mergeAll(NodeServices.layer, IdAllocator.layer);
const encodeFrame = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const isNativeTurnStart = Schema.is(
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

const integration = (
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
    driver.setHost({
      release,
      buildRuntime: ({ harness }) =>
        Effect.sync(() =>
          makeCodexNativeHostBinding({
            process: { ...context.options, computer: harness.computer },
            adapter,
            modelOrigins: ["https://harness-mcp.invalid"],
            mcpSessions: {
              set: () => Effect.die("Unexpected app MCP fallback"),
              read: () => Effect.succeed(undefined),
              clear: () => Effect.die("Unexpected app MCP fallback"),
            },
          }),
        ),
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
    return { driver, call, facet, peer, run };
  });

describe("request-turn native load through the real Codex binding", () => {
  it.effect.each(["thread/start", "thread/resume"] as const)(
    "fences held %s on replacement and calibrates one successful start and checkpoint",
    (setup) =>
      Effect.gen(function* () {
        const setupEntered = Promise.withResolvers<void>();
        const releaseSetup = Promise.withResolvers<void>();
        const held = yield* integration(setup, async (method) => {
          if (method === setup) {
            setupEntered.resolve();
            await releaseSetup.promise;
          }
        });
        const pending = yield* held.run.pipe(Effect.result, Effect.forkScoped);
        const reachedSetup = yield* Effect.raceFirst(
          Effect.promise(() => setupEntered.promise).pipe(Effect.as("native-setup")),
          Fiber.await(pending).pipe(Effect.as("request-finished")),
        );
        expect(reachedSetup).toBe("native-setup");

        const replaced = yield* held.call(install(2));
        expect(replaced.snapshot.requests?.entries[0]?.status).toBe("indeterminate");
        releaseSetup.resolve();
        expect(Result.isFailure(yield* Fiber.join(pending))).toBe(true);
        expect(held.peer.sent).toEqual([setup]);
        expect(held.driver.publications.some((item) => item.kind === "turn.started")).toBe(false);
        expect(held.driver.exports).toHaveLength(0);
        expect(held.driver.terminals).toHaveLength(0);
        const fenced = yield* held.call({ type: "read", runId });
        expect(fenced.snapshot.requests?.entries[0]?.finish).toBe(null);
        yield* held.facet.dispose;

        const setupEnteredForCalibration = Promise.withResolvers<void>();
        const releaseSetupForCalibration = Promise.withResolvers<void>();
        const turnStartEntered = Promise.withResolvers<void>();
        const releaseTurnStart = Promise.withResolvers<void>();
        const calibrated = yield* integration(setup, async (method) => {
          if (method === setup) {
            setupEnteredForCalibration.resolve();
            await releaseSetupForCalibration.promise;
          }
          if (method === "turn/start") {
            turnStartEntered.resolve();
            await releaseTurnStart.promise;
          }
        });
        const publishedStart = yield* Deferred.make<void>();
        calibrated.driver.setPublication((item) =>
          item.kind === "provider" && isNativeTurnStart(item.event)
            ? Deferred.succeed(publishedStart, undefined)
            : Effect.void,
        );
        const running = yield* calibrated.run.pipe(Effect.result, Effect.forkScoped);
        const calibrationReachedSetup = yield* Effect.raceFirst(
          Effect.promise(() => setupEnteredForCalibration.promise).pipe(Effect.as("native-setup")),
          Fiber.await(running).pipe(Effect.as("request-finished")),
        );
        expect(calibrationReachedSetup).toBe("native-setup");
        releaseSetupForCalibration.resolve();
        const turnWasSent = yield* Effect.raceFirst(
          Effect.promise(() => turnStartEntered.promise).pipe(Effect.as("turn-start")),
          Fiber.await(running).pipe(Effect.as("request-finished")),
        );
        expect(turnWasSent).toBe("turn-start");
        releaseTurnStart.resolve();
        yield* Deferred.await(publishedStart);

        const output = yield* Effect.promise(() => calibrated.peer.output);
        output.enqueue(
          new TextEncoder().encode(
            encodeFrame({
              method: "turn/completed",
              params: {
                threadId: "preinitialized-native-thread",
                turn: {
                  id: "preinitialized-turn",
                  status: "completed",
                  items: [],
                  error: null,
                },
              },
            }) + "\n",
          ),
        );
        const completed = yield* Fiber.join(running);
        if (Result.isFailure(completed)) return yield* Effect.fail(completed.failure);
        expect(completed.success.action).toBe("committed");
        expect(completed.success.snapshot.requests?.entries[0]?.status).toBe("completed");
        expect(completed.success.snapshot.requests?.entries[0]?.finish?.status).toBe("completed");
        expect(calibrated.peer.sent.filter((method) => method !== "thread/read")).toEqual([
          setup,
          "turn/start",
        ]);
        expect(launch).toHaveBeenCalledTimes(1);
        expect(calibrated.driver.exports).toHaveLength(1);
        expect(calibrated.driver.terminals).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
