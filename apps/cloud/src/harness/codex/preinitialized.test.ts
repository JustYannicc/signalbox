import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { processFixture, openAdapter, session, readyLine } from "./tests/preinitializedFixture.ts";

const encoder = new TextEncoder();

describe("Codex preinitialized session", () => {
  it.effect("waits for observed ready, then starts a thread without a second initialize", () =>
    Effect.gen(function* () {
      const fixture = processFixture();
      const runtime = yield* openAdapter(fixture.process);
      const ensuring = yield* runtime.ensureThread(session).pipe(Effect.forkScoped);
      expect(yield* Effect.promise(() => fixture.started)).toBe("ready-wait");
      expect(fixture.sent).toEqual([]);
      const output = yield* Effect.promise(() => fixture.output);
      output.enqueue(encoder.encode(readyLine.slice(0, 11)));
      expect(fixture.sent).toEqual([]);
      output.enqueue(encoder.encode(readyLine.slice(11)));
      const thread = yield* Fiber.join(ensuring);
      expect(thread.nativeThreadRef?.nativeId).toBe("preinitialized-native-thread");
      expect(fixture.sent).toEqual(["thread/start"]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
      ),
    ),
  );

  it.effect("fails readiness without allocating a thread when stdout ends before ready", () =>
    Effect.gen(function* () {
      const fixture = processFixture();
      const runtime = yield* openAdapter(fixture.process);
      const ensuring = yield* runtime.ensureThread(session).pipe(Effect.flip, Effect.forkScoped);
      expect(yield* Effect.promise(() => fixture.started)).toBe("ready-wait");
      (yield* Effect.promise(() => fixture.output)).close();
      const error = yield* Fiber.join(ensuring);
      expect(error).toBeInstanceOf(ProviderAdapter.ProviderAdapterEnsureThreadError);
      expect(error.cause).toMatchObject({
        _tag: "CodexAppServerTransportError",
        operation: "read-input-stream",
        cause: expect.objectContaining({
          message: expect.stringContaining("ended before signalbox/ready"),
        }),
      });
      expect(fixture.sent).toEqual([]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
      ),
    ),
  );
});
