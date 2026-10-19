// @effect-diagnostics abortControllerInEffect:off - these independently owned access/request signals are the inputs under test.
import { describe, expect, it } from "@effect/vitest";
import { RunAttemptId, RunId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { hostFixture } from "./hostFixture.ts";

describe("Harness host turn grants", () => {
  it.effect.each(["grant", "signal", "connections"] as const)(
    "rejects a duplicate after the accepted access %s changes through an alias",
    (field) =>
      Effect.gen(function* () {
        const f = yield* hostFixture;
        const instance = yield* f.make();
        yield* instance.host.seed("assets");
        yield* instance.host.seed("programs");
        const session = yield* instance.open();
        const original = f.access("accepted-grant");
        const access = {
          ...original,
          connections: {
            servers: original.connections.servers.map((server) => ({
              ...server,
              directTools: [...server.directTools],
            })),
          },
        };
        yield* session.turn({ turn: instance.adapter.turn, access });
        yield* instance.adapter.nextStart;
        const url = f.configurations[0]!.servers.executor!.url;
        const forwards = f.forwards.length;
        const starts = instance.adapter.calls.filter((call) => call === "start").length;
        if (field === "grant") access.grant = { secret: "changed-grant" };
        if (field === "signal") access.signal = new AbortController().signal;
        if (field === "connections")
          access.connections.servers[0]!.directTools.push("changed-tool");
        expect(
          Exit.isFailure(
            yield* session.turn({ turn: instance.adapter.turn, access }).pipe(Effect.exit),
          ),
        ).toBe(true);
        expect(f.configurations).toHaveLength(1);
        expect(f.forwards).toHaveLength(forwards);
        expect(instance.adapter.calls.filter((call) => call === "start")).toHaveLength(starts);
        yield* Effect.promise(() => f.mcp.fetch(new Request(url)));
        expect(f.forwards.at(-1)?.grant).toBe(original.grant);
        access.grant = original.grant;
        access.signal = original.signal;
        access.connections = {
          servers: original.connections.servers.map((server) => ({
            ...server,
            directTools: [...server.directTools],
          })),
        };
        yield* session.turn({ turn: instance.adapter.turn, access });
        expect(f.configurations).toHaveLength(1);
        yield* session.dispose;
      }).pipe(Effect.scoped),
  );

  it.effect(
    "rotates grants on one session, retires terminal grants without draining public events and isolates late A",
    () =>
      Effect.gen(function* () {
        const f = yield* hostFixture;
        f.useSubscription();
        const instance = yield* f.make();
        yield* instance.host.seed("assets");
        yield* instance.host.seed("programs");
        const session = yield* instance.open();
        const aController = new AbortController();
        const accessA = f.access("opaque-A", aController);
        yield* session.turn({ turn: instance.adapter.turn, access: accessA });
        yield* instance.adapter.nextStart;
        const first = f.configurations[0]!;
        expect(Object.keys(first.servers)).toEqual(["executor", "normal-server"]);
        for (const endpoint of Object.values(first.servers))
          yield* Effect.promise(async () => {
            expect(await (await f.mcp.fetch(new Request(endpoint.url))).text()).toBe("executor");
          });
        expect(f.forwards.map((call) => call.grant)).toEqual([accessA.grant, accessA.grant]);
        expect(f.forwards.map((call) => call.target)).toEqual([
          { type: "executor" },
          { type: "direct", serverId: "normal-server-id", tools: ["direct_tool"] },
        ]);
        yield* session.turn({ turn: instance.adapter.turn, access: accessA });
        expect(
          Exit.isFailure(
            yield* session
              .turn({ turn: instance.adapter.turn, access: f.access("different") })
              .pipe(Effect.exit),
          ),
        ).toBe(true);
        expect(f.configurations).toHaveLength(1);
        yield* instance.adapter.terminal();
        yield* instance.adapter.saving;
        const terminalForwards = f.forwards.length;
        yield* Effect.promise(() =>
          expect(f.mcp.fetch(new Request(first.servers.executor!.url))).rejects.toThrow(),
        );
        expect(f.forwards).toHaveLength(terminalForwards);
        const accessB = f.access("opaque-B");
        const turnB = {
          ...instance.adapter.turn,
          runId: RunId.make("run-2"),
          attemptId: RunAttemptId.make("attempt-2"),
          runOrdinal: 2,
          providerTurnOrdinal: 2,
        };
        yield* session.turn({ turn: turnB, access: accessB });
        yield* instance.adapter.nextStart;
        const second = f.configurations[1]!;
        expect(second.servers.executor!.url).not.toBe(first.servers.executor!.url);
        aController.abort();
        yield* instance.adapter.terminal();
        yield* Effect.promise(async () => {
          expect(await (await f.mcp.fetch(new Request(second.servers.executor!.url))).text()).toBe(
            "executor",
          );
        });
        expect(f.forwards.at(-1)?.grant).toBe(accessB.grant);
        expect(f.acquisitions).toHaveLength(1);
        const persisted = JSON.stringify(f.handle.rows("SELECT * FROM harness_boot_attempts"));
        expect(persisted).not.toContain("opaque-");
        expect(JSON.stringify(f.configurations)).not.toContain("opaque-");
        yield* session.dispose;
      }).pipe(Effect.scoped),
  );

  it.effect(
    "cancels pending calls on access/request/owner abort and sanitizes Executor errors",
    () =>
      Effect.gen(function* () {
        const f = yield* hostFixture;
        const instance = yield* f.make();
        yield* instance.host.seed("assets");
        yield* instance.host.seed("programs");
        const session = yield* instance.open();
        const controller = new AbortController();
        yield* session.turn({ turn: instance.adapter.turn, access: f.access("grant", controller) });
        const url = f.configurations[0]!.servers.executor!.url;
        const called = Promise.withResolvers<AbortSignal>();
        f.setForward((input) => {
          called.resolve(input.signal);
          return new Promise<Response>(() => undefined);
        });
        const request = new AbortController();
        const pending = yield* Effect.promise(() =>
          f.mcp.fetch(new Request(url, { signal: request.signal })),
        ).pipe(Effect.exit, Effect.forkScoped);
        const requestSignal = yield* Effect.promise(() => called.promise);
        request.abort("opaque-grant-secret");
        expect(Exit.isFailure(yield* Fiber.join(pending))).toBe(true);
        expect(requestSignal.aborted).toBe(true);
        f.setForward(async () => {
          throw new Error("opaque-grant-secret");
        });
        const failure = yield* Effect.promise(() => f.mcp.fetch(new Request(url))).pipe(
          Effect.exit,
        );
        expect(Exit.isFailure(failure)).toBe(true);
        if (Exit.isFailure(failure))
          expect(Cause.pretty(failure.cause)).not.toContain("opaque-grant-secret");
        controller.abort();
        const cancelledForwards = f.forwards.length;
        yield* Effect.promise(() => expect(f.mcp.fetch(new Request(url))).rejects.toThrow());
        expect(f.forwards).toHaveLength(cancelledForwards);
        yield* instance.adapter.named();
        yield* session.control({
          type: "interrupt",
          runId: instance.adapter.turn.runId,
          preparationGeneration: 1,
        });
        yield* instance.adapter.nextInterrupt;
        yield* Scope.close(instance.lifetime, Exit.void);
        expect(
          Exit.isFailure(
            yield* session
              .turn({ turn: instance.adapter.turn, access: f.access("new") })
              .pipe(Effect.exit),
          ),
        ).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "rejects stale starts and unsupported configuration without fallback or grant leakage",
    () =>
      Effect.gen(function* () {
        const f = yield* hostFixture;
        const instance = yield* f.make();
        yield* instance.host.seed("assets");
        yield* instance.host.seed("programs");
        const session = yield* instance.open();
        expect(
          Exit.isFailure(
            yield* session
              .turn({ turn: { ...instance.adapter.turn, runOrdinal: 0 }, access: f.access("bad") })
              .pipe(Effect.exit),
          ),
        ).toBe(true);
        expect(f.configurations).toHaveLength(0);
        f.failConfiguration();
        const exit = yield* session
          .turn({ turn: instance.adapter.turn, access: f.access("opaque-grant-secret") })
          .pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit))
          expect(Cause.pretty(exit.cause)).not.toContain("opaque-grant-secret");
        expect(instance.adapter.calls).not.toContain("start");
        expect(f.acquisitions).toHaveLength(1);
        const failedForwards = f.forwards.length;
        yield* Effect.promise(() =>
          expect(
            f.mcp.fetch(new Request(f.configurations[0]!.servers.executor!.url)),
          ).rejects.toThrow(),
        );
        expect(f.forwards).toHaveLength(failedForwards);
      }).pipe(Effect.scoped),
  );
  it.effect.each(["access", "terminal", "owner"] as const)(
    "aborts an in-flight Executor request when %s ownership ends",
    (end) =>
      Effect.gen(function* () {
        const f = yield* hostFixture;
        const instance = yield* f.make();
        yield* instance.host.seed("assets");
        yield* instance.host.seed("programs");
        const session = yield* instance.open();
        const accessOwner = new AbortController();
        yield* session.turn({
          turn: instance.adapter.turn,
          access: f.access("opaque", accessOwner),
        });
        const called = Promise.withResolvers<AbortSignal>();
        f.setForward((input) => {
          called.resolve(input.signal);
          return new Promise<Response>(() => undefined);
        });
        const pending = yield* Effect.promise(() =>
          f.mcp.fetch(new Request(f.configurations[0]!.servers.executor!.url)),
        ).pipe(Effect.exit, Effect.forkScoped);
        const signal = yield* Effect.promise(() => called.promise);
        if (end === "access") accessOwner.abort();
        if (end === "terminal") {
          yield* instance.adapter.terminal();
          yield* instance.adapter.saving;
        }
        if (end === "owner") yield* instance.host.dispose;
        expect(signal.aborted).toBe(true);
        expect(Exit.isFailure(yield* Fiber.join(pending))).toBe(true);
        const retiredForwards = f.forwards.length;
        yield* Effect.promise(() =>
          expect(
            f.mcp.fetch(new Request(f.configurations[0]!.servers.executor!.url)),
          ).rejects.toThrow(),
        );
        expect(f.forwards).toHaveLength(retiredForwards);
      }).pipe(Effect.scoped),
  );

  it.effect("cancels a blocked configuration before any prompt and clears its epoch", () =>
    Effect.gen(function* () {
      const f = yield* hostFixture;
      const instance = yield* f.make();
      yield* instance.host.seed("assets");
      yield* instance.host.seed("programs");
      const session = yield* instance.open();
      const gate = yield* Deferred.make<void>();
      f.setConfigureGate(Deferred.await(gate));
      const accessOwner = new AbortController();
      const starting = yield* session
        .turn({ turn: instance.adapter.turn, access: f.access("opaque", accessOwner) })
        .pipe(Effect.exit, Effect.forkScoped);
      const config = yield* f.nextConfiguration;
      accessOwner.abort();
      expect(Exit.isFailure(yield* Fiber.join(starting))).toBe(true);
      expect(instance.adapter.calls).not.toContain("start");
      const cancelledForwards = f.forwards.length;
      yield* Effect.promise(() =>
        expect(f.mcp.fetch(new Request(config.servers.executor!.url))).rejects.toThrow(),
      );
      expect(f.forwards).toHaveLength(cancelledForwards);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "awaits configuration, rejects active and duplicate conflicts before rotation, and forwards model transport separately",
    () =>
      Effect.gen(function* () {
        const f = yield* hostFixture;
        const instance = yield* f.make();
        yield* instance.host.seed("assets");
        yield* instance.host.seed("programs");
        const session = yield* instance.open();
        const gate = yield* Deferred.make<void>();
        f.setConfigureGate(Deferred.await(gate));
        const access = f.access("opaque");
        const starting = yield* session
          .turn({ turn: instance.adapter.turn, access })
          .pipe(Effect.forkScoped);
        yield* f.nextConfiguration;
        expect(instance.adapter.calls).not.toContain("start");
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(starting);
        const next = { ...instance.adapter.turn, runId: RunId.make("next"), runOrdinal: 2 };
        expect(
          Exit.isFailure(
            yield* session.turn({ turn: next, access: f.access("other") }).pipe(Effect.exit),
          ),
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* session
              .turn({
                turn: {
                  ...instance.adapter.turn,
                  message: { ...instance.adapter.turn.message, text: "changed" },
                },
                access,
              })
              .pipe(Effect.exit),
          ),
        ).toBe(true);
        expect(f.configurations).toHaveLength(1);
        const request = new Request("https://model.invalid/model");
        yield* Effect.promise(async () =>
          expect(await (await f.runtimeInput.harness.modelTransport(request)).text()).toBe("model"),
        );
        expect(f.transportRequests).toHaveLength(1);
        yield* Effect.promise(async () =>
          expect(
            await (
              await f.runtimeInput.harness.modelTransport(
                new Request(f.configurations[0]!.servers.executor!.url),
              )
            ).text(),
          ).toBe("executor"),
        );
        expect(f.transportRequests).toHaveLength(1);
      }).pipe(Effect.scoped),
  );
  it.effect("starts the accepted turn snapshot when caller data changes during configuration", () =>
    Effect.gen(function* () {
      const f = yield* hostFixture;
      const instance = yield* f.make();
      yield* instance.host.seed("assets");
      yield* instance.host.seed("programs");
      const session = yield* instance.open();
      const gate = yield* Deferred.make<void>();
      f.setConfigureGate(Deferred.await(gate));
      const turn = {
        ...instance.adapter.turn,
        message: { ...instance.adapter.turn.message, text: "accepted" },
      };
      const starting = yield* session
        .turn({ turn, access: f.access("opaque") })
        .pipe(Effect.forkScoped);
      yield* f.nextConfiguration;
      turn.message.text = "changed";
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(starting);
      const started = yield* instance.adapter.nextStart;
      expect(started.message.text).toBe("accepted");
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a direct server name collision before configuration and grant rotation", () =>
    Effect.gen(function* () {
      const f = yield* hostFixture;
      const instance = yield* f.make();
      yield* instance.host.seed("assets");
      yield* instance.host.seed("programs");
      const session = yield* instance.open();
      const access = f.access("opaque");
      const conflicting = {
        ...access,
        connections: { servers: [{ id: "server", name: "executor", directTools: ["tool"] }] },
      };
      expect(
        Exit.isFailure(
          yield* session
            .turn({ turn: instance.adapter.turn, access: conflicting })
            .pipe(Effect.exit),
        ),
      ).toBe(true);
      expect(f.configurations).toHaveLength(0);
      yield* session.turn({ turn: instance.adapter.turn, access });
      expect(f.configurations).toHaveLength(1);
    }).pipe(Effect.scoped),
  );
  it.effect(
    "cancels acquired response bodies with owner shutdown and redacts cancellation failures",
    () =>
      Effect.gen(function* () {
        const f = yield* hostFixture;
        const instance = yield* f.make();
        yield* instance.host.seed("assets");
        yield* instance.host.seed("programs");
        const session = yield* instance.open();
        yield* session.turn({ turn: instance.adapter.turn, access: f.access("opaque") });
        const reading = Promise.withResolvers<void>();
        let cancelled = 0;
        f.setForward(
          async () =>
            new Response(
              new ReadableStream<Uint8Array>(
                {
                  pull() {
                    reading.resolve();
                  },
                  cancel() {
                    cancelled++;
                    throw new Error("opaque-grant-secret");
                  },
                },
                { highWaterMark: 0 },
              ),
            ),
        );
        const url = f.configurations[0]!.servers.executor!.url;
        const first = yield* Effect.promise(() => f.mcp.fetch(new Request(url)));
        const cancelledExit = yield* Effect.promise(() => first.body!.cancel()).pipe(Effect.exit);
        expect(Exit.isFailure(cancelledExit)).toBe(true);
        if (Exit.isFailure(cancelledExit))
          expect(Cause.pretty(cancelledExit.cause)).not.toContain("opaque-grant-secret");
        const second = yield* Effect.promise(() => f.mcp.fetch(new Request(url)));
        const pending = yield* Effect.promise(() => second.body!.getReader().read()).pipe(
          Effect.exit,
          Effect.forkScoped,
        );
        yield* Effect.promise(() => reading.promise);
        yield* instance.host.dispose;
        expect(Exit.isFailure(yield* Fiber.join(pending))).toBe(true);
        expect(cancelled).toBe(2);
      }).pipe(Effect.scoped),
  );
});
