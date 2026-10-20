import { describe, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { RunId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { HarnessCheckpoint } from "../Harness.ts";
import type { CodexHarnessProcess, CodexHarnessProcessOptions } from "../CodexHarnessProcess.ts";
import { hostBindingFixture } from "./tests/hostBindingFixture.ts";

const launch = vi.hoisted(() =>
  vi.fn<(input: CodexHarnessProcessOptions) => Promise<CodexHarnessProcess>>(),
);
vi.mock("../CodexHarnessProcess.ts", () => ({ startCodexHarnessProcess: launch }));
const layer = Layer.mergeAll(NodeServices.layer, IdAllocator.layer);
const encodeFrame = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeServers = Schema.decodeUnknownSync(
  Schema.Struct({
    config: Schema.Struct({
      mcp_servers: Schema.Struct({ executor: Schema.Struct({ url: Schema.String }) }),
    }),
  }),
);
const checkpointFor = (
  instance: Effect.Success<ReturnType<typeof hostBindingFixture>>["instance"],
): HarnessCheckpoint => ({
  release: instance.host.release,
  providerSession: instance.adapter.runtime.providerSession,
  snapshot: {
    providerThread: {
      ...instance.adapter.turn.providerThread,
      status: "idle",
      nativeThreadRef: {
        driver: instance.adapter.runtime.driver,
        nativeId: "preinitialized-native-thread",
        strength: "strong",
      },
    },
    providerTurns: [],
    messages: [],
    runtimeRequests: [],
  },
  revision: { commit: "checkpoint-revision" },
});

describe("Codex binding through the canonical host and facet", () => {
  it.effect("loads one native thread and sends one prompt through the canonical adapter", () =>
    Effect.gen(function* () {
      const { f, instance, peer } = yield* hostBindingFixture();
      launch.mockResolvedValue(peer.process);
      const session = yield* instance.open();
      const result = yield* session
        .turn({ turn: instance.adapter.turn, access: f.access("bound") })
        .pipe(Effect.exit);
      expect(peer.sent).toEqual(["thread/start", "turn/start"]);
      expect(Exit.isSuccess(result)).toBe(true);
      yield* session.dispose;
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "awaits cold resume with initial access before open succeeds, then reuses it for the first turn",
    () =>
      Effect.gen(function* () {
        const entered = Promise.withResolvers<void>();
        const reply = Promise.withResolvers<void>();
        const { f, instance, peer } = yield* hostBindingFixture(async (method) => {
          if (method === "thread/resume") {
            entered.resolve();
            await reply.promise;
          }
        });
        launch.mockResolvedValue(peer.process);
        const checkpoint = checkpointFor(instance);
        const access = f.access("private-checkpoint-grant");
        const opening = yield* instance.host
          .open({
            session: instance.adapter.input.session,
            checkpoint,
            initialAccess: access,
            bootAttemptId: "cold",
          })
          .pipe(Effect.forkScoped);
        const first = yield* Effect.raceFirst(
          Effect.promise(() => entered.promise).pipe(Effect.as("resume-entered")),
          Fiber.await(opening).pipe(Effect.as("open-returned")),
        );
        expect(first).toBe("resume-entered");
        expect(peer.sent).toEqual(["thread/resume"]);
        reply.resolve();
        const session = yield* Fiber.join(opening);
        expect((yield* session.export()).snapshot.providerThread.nativeThreadRef?.nativeId).toBe(
          "preinitialized-native-thread",
        );
        yield* session.turn({
          turn: { ...instance.adapter.turn, providerThread: checkpoint.snapshot.providerThread },
          access,
        });
        expect(peer.sent).toEqual(["thread/resume", "thread/read", "turn/start"]);
        expect(JSON.stringify(f.handle.rows("SELECT * FROM harness_boot_attempts"))).not.toContain(
          "private-checkpoint-grant",
        );
        yield* session.dispose;
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("rejects missing or aborted initial access before acquiring a native process", () =>
    Effect.gen(function* () {
      const { f, instance, peer } = yield* hostBindingFixture();
      launch.mockResolvedValue(peer.process);
      const checkpoint = checkpointFor(instance);
      const access = f.access("aborted", new AbortController());
      const missing = {
        session: instance.adapter.input.session,
        checkpoint,
        initialAccess: access,
        bootAttemptId: "missing",
      };
      Reflect.deleteProperty(missing, "initialAccess");
      // Runtime validation also rejects untyped callers.
      const outcome = yield* instance.host.open(missing).pipe(Effect.exit);
      expect(Exit.isFailure(outcome)).toBe(true);
      const controller = new AbortController();
      controller.abort();
      expect(
        Exit.isFailure(
          yield* instance.host
            .open({
              ...missing,
              initialAccess: { ...access, signal: controller.signal },
              bootAttemptId: "aborted",
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true);
      expect(peer.sent).toEqual([]);
      expect(f.handle.rows("SELECT * FROM harness_boot_attempts")).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("rejects changed checkpoint access before a prompt or replacement map", () =>
    Effect.gen(function* () {
      const { f, instance, peer } = yield* hostBindingFixture();
      launch.mockResolvedValue(peer.process);
      const checkpoint = checkpointFor(instance);
      const access = f.access("accepted");
      const input = {
        session: instance.adapter.input.session,
        checkpoint,
        initialAccess: access,
        bootAttemptId: "cold",
      };
      const session = yield* instance.host.open(input);
      expect(yield* instance.host.open(input)).toBe(session);
      expect(
        Exit.isFailure(
          yield* instance.host
            .open({ ...input, initialAccess: f.access("changed") })
            .pipe(Effect.exit),
        ),
      ).toBe(true);
      expect(
        Exit.isFailure(
          yield* session
            .turn({
              turn: {
                ...instance.adapter.turn,
                providerThread: checkpoint.snapshot.providerThread,
              },
              access: f.access("changed"),
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true);
      expect(peer.sent).toEqual(["thread/resume"]);
      yield* session.turn({
        turn: { ...instance.adapter.turn, providerThread: checkpoint.snapshot.providerThread },
        access,
      });
      expect(peer.sent).toEqual(["thread/resume", "turn/start"]);
      yield* session.dispose;
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("aborts a pending cold resume without accepting its late response", () =>
    Effect.gen(function* () {
      const entered = Promise.withResolvers<void>();
      const reply = Promise.withResolvers<void>();
      const { f, instance, peer } = yield* hostBindingFixture(async (method) => {
        if (method === "thread/resume") {
          entered.resolve();
          await reply.promise;
        }
      });
      launch.mockResolvedValue(peer.process);
      const checkpoint = checkpointFor(instance);
      const controller = new AbortController();
      const access = f.access("pending", controller);
      const opening = yield* instance.host
        .open({
          session: instance.adapter.input.session,
          checkpoint,
          initialAccess: access,
          bootAttemptId: "cold",
        })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Effect.promise(() => entered.promise);
      controller.abort();
      expect(Exit.isFailure(yield* Fiber.join(opening))).toBe(true);
      reply.resolve();
      const url = decodeServers(peer.requests[0]?.params).config.mcp_servers.executor.url;
      expect(
        Exit.isFailure(
          yield* Effect.tryPromise(() => f.mcp.fetch(new Request(url))).pipe(Effect.exit),
        ),
      ).toBe(true);
      expect(peer.sent).toEqual(["thread/resume"]);
      expect(
        Exit.isFailure(
          yield* instance.host
            .open({
              session: instance.adapter.input.session,
              checkpoint,
              initialAccess: access,
              bootAttemptId: "cold",
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "retires native MCP routes at terminal and refuses another map on the same incarnation",
    () =>
      Effect.gen(function* () {
        const { f, instance, peer } = yield* hostBindingFixture();
        launch.mockResolvedValue(peer.process);
        const session = yield* instance.open();
        const access = f.access("bound");
        const terminal = yield* session.events.pipe(
          Stream.filter((item) => item.kind === "provider" && item.event.type === "turn.terminal"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* session.turn({ turn: instance.adapter.turn, access });
        const output = yield* Effect.promise(() => peer.output);
        output.enqueue(
          new TextEncoder().encode(
            encodeFrame({
              method: "turn/completed",
              params: {
                threadId: "preinitialized-native-thread",
                turn: { id: "preinitialized-turn", status: "completed", items: [], error: null },
              },
            }) + "\n",
          ),
        );
        yield* Fiber.join(terminal);
        const url = decodeServers(peer.requests[0]?.params).config.mcp_servers.executor.url;
        expect(
          Exit.isFailure(
            yield* Effect.tryPromise(() => f.mcp.fetch(new Request(url))).pipe(Effect.exit),
          ),
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* session
              .turn({
                turn: { ...instance.adapter.turn, runId: RunId.make("next-run"), runOrdinal: 2 },
                access,
              })
              .pipe(Effect.exit),
          ),
        ).toBe(true);
        expect(peer.sent).toEqual(["thread/start", "turn/start"]);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
