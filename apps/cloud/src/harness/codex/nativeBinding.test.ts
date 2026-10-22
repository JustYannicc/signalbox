import { describe, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { CodexHarnessProcess, CodexHarnessProcessOptions } from "../CodexHarnessProcess.ts";
import { HarnessError } from "../Harness.ts";
import type { NativeThreadLoad } from "../HarnessSessionHost.ts";
import { bindingFixture, coldThread } from "./tests/nativeBindingFixture.ts";
import { session } from "./tests/preinitializedFixture.ts";

const launch = vi.hoisted(() =>
  vi.fn<(input: CodexHarnessProcessOptions) => Promise<CodexHarnessProcess>>(),
);
vi.mock("../CodexHarnessProcess.ts", () => ({ startCodexHarnessProcess: launch }));
const decodeMap = Schema.decodeUnknownSync(
  Schema.Struct({
    config: Schema.Struct({
      mcp_servers: Schema.Record(Schema.String, Schema.Struct({ url: Schema.String })),
    }),
  }),
);
const encodeHarnessError = Schema.encodeUnknownSync(Schema.toCodecJson(HarnessError));
const layer = Layer.mergeAll(NodeServices.layer, IdAllocator.layer);
const servers = { executor: { url: "https://harness-mcp.invalid/owner/1/1/0" } };
const reporter = { releaseModuleOmitted: () => undefined };
const ensure: NativeThreadLoad = { method: "ensureThread", input: session };
const resume = {
  method: "resumeThread" as const,
  input: { ...session, providerThread: coldThread },
};

describe("Codex native binding", () => {
  it.effect.each([ensure, resume])("awaits real $method and hands off its result once", (load) =>
    Effect.gen(function* () {
      const entered = Promise.withResolvers<void>();
      const reply = Promise.withResolvers<void>();
      const f = yield* bindingFixture(async () => {
        entered.resolve();
        await reply.promise;
      });
      launch.mockResolvedValue(f.peer.process);
      const runtime = yield* f.binding.factory.open(f.harness, reporter);
      let finished = false;
      const configuring = yield* f.binding
        .configureMcp({ epoch: 1, servers }, new AbortController().signal, load)
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              finished = true;
            }),
          ),
          Effect.forkScoped,
        );
      yield* Effect.promise(() => entered.promise);
      expect(finished).toBe(false);
      expect(f.peer.sent).toEqual([
        load.method === "ensureThread" ? "thread/start" : "thread/resume",
      ]);
      expect(decodeMap(f.peer.requests[0]?.params).config.mcp_servers).toEqual(servers);
      reply.resolve();
      yield* Fiber.join(configuring);
      const handoff =
        load.method === "ensureThread"
          ? runtime.ensureThread(load.input)
          : runtime.resumeThread(load.input);
      expect((yield* handoff).nativeThreadRef?.nativeId).toBe("preinitialized-native-thread");
      expect(Exit.isFailure(yield* Effect.exit(handoff))).toBe(true);
      expect(f.peer.requests).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("installs an exact empty map without app-session fallback", () =>
    Effect.gen(function* () {
      const f = yield* bindingFixture();
      launch.mockResolvedValue(f.peer.process);
      const runtime = yield* f.binding.factory.open(f.harness, reporter);
      yield* f.binding.configureMcp(
        { epoch: 1, servers: {} },
        new AbortController().signal,
        ensure,
      );
      yield* runtime.ensureThread(session);
      expect(decodeMap(f.peer.requests[0]?.params).config.mcp_servers).toEqual({});
      expect(f.peer.sent).toEqual(["thread/start"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("rejects aborted access before native setup", () =>
    Effect.gen(function* () {
      const f = yield* bindingFixture();
      launch.mockResolvedValue(f.peer.process);
      yield* f.binding.factory.open(f.harness, reporter);
      const controller = new AbortController();
      controller.abort();
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            f.binding.configureMcp({ epoch: 1, servers }, controller.signal, ensure),
          ),
        ),
      ).toBe(true);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            f.binding.configureMcp({ epoch: 2, servers }, new AbortController().signal, ensure),
          ),
        ),
      ).toBe(true);
      expect(f.peer.sent).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("cannot adopt a late native reply after access abort", () =>
    Effect.gen(function* () {
      const entered = Promise.withResolvers<void>();
      const reply = Promise.withResolvers<void>();
      const f = yield* bindingFixture(async () => {
        entered.resolve();
        await reply.promise;
      });
      launch.mockResolvedValue(f.peer.process);
      const runtime = yield* f.binding.factory.open(f.harness, reporter);
      const controller = new AbortController();
      const configuring = yield* f.binding
        .configureMcp({ epoch: 1, servers }, controller.signal, ensure)
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Effect.promise(() => entered.promise);
      controller.abort();
      expect(Exit.isFailure(yield* Fiber.join(configuring))).toBe(true);
      reply.resolve();
      expect(Exit.isFailure(yield* Effect.exit(runtime.ensureThread(session)))).toBe(true);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            f.binding.configureMcp({ epoch: 2, servers }, new AbortController().signal, ensure),
          ),
        ),
      ).toBe(true);
      expect(f.peer.sent).toEqual(["thread/start"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("rejects racing/repeated maps and snapshots the map before native wait", () =>
    Effect.gen(function* () {
      const entered = Promise.withResolvers<void>();
      const reply = Promise.withResolvers<void>();
      const f = yield* bindingFixture(async () => {
        entered.resolve();
        await reply.promise;
      });
      launch.mockResolvedValue(f.peer.process);
      yield* f.binding.factory.open(f.harness, reporter);
      const signal = new AbortController().signal;
      const supplied = { executor: { url: servers.executor.url } };
      const configuring = yield* f.binding
        .configureMcp({ epoch: 1, servers: supplied }, signal, ensure)
        .pipe(Effect.forkScoped);
      yield* Effect.promise(() => entered.promise);
      supplied.executor.url = "https://changed.invalid";
      expect(
        Exit.isFailure(
          yield* Effect.exit(f.binding.configureMcp({ epoch: 2, servers: {} }, signal, ensure)),
        ),
      ).toBe(true);
      reply.resolve();
      yield* Fiber.join(configuring);
      expect(decodeMap(f.peer.requests[0]?.params).config.mcp_servers).toEqual(servers);
      expect(
        Exit.isFailure(
          yield* Effect.exit(f.binding.configureMcp({ epoch: 3, servers: {} }, signal, ensure)),
        ),
      ).toBe(true);
      expect(f.peer.sent).toEqual(["thread/start"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("rejects premature/conflicting handoffs without reopening native state", () =>
    Effect.gen(function* () {
      const f = yield* bindingFixture();
      launch.mockResolvedValue(f.peer.process);
      const runtime = yield* f.binding.factory.open(f.harness, reporter);
      expect(Exit.isFailure(yield* Effect.exit(runtime.ensureThread(session)))).toBe(true);
      yield* f.binding.configureMcp({ epoch: 1, servers }, new AbortController().signal, ensure);
      expect(Exit.isFailure(yield* Effect.exit(runtime.resumeThread(resume.input)))).toBe(true);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            runtime.ensureThread({
              ...session,
              modelSelection: { ...session.modelSelection, model: "different" },
            }),
          ),
        ),
      ).toBe(true);
      yield* runtime.ensureThread(session);
      expect(f.peer.sent).toEqual(["thread/start"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("rejects a second factory open with main's tagged error codec", () =>
    Effect.gen(function* () {
      const f = yield* bindingFixture();
      launch.mockResolvedValue(f.peer.process);
      yield* f.binding.factory.open(f.harness, reporter);
      const failure = yield* f.binding.factory.open(f.harness, reporter).pipe(Effect.flip);
      expect(encodeHarnessError(failure)).toEqual({
        _tag: "HarnessError",
        operation: "open",
        message: "Codex factory requires fresh owned streams for another native session.",
      });
      expect(f.peer.sent).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
