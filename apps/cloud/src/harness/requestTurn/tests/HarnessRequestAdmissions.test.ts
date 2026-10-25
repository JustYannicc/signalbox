import { describe, expect, it } from "@effect/vitest";
import { RunId, RunAttemptId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { HarnessRequestFacetError } from "../../HarnessRequestFacet.ts";
import { requestFixture } from "./fixture.ts";

describe("Harness request admissions", () => {
  it.effect(
    "keeps the native owner alive and checks the second request at external boundaries",
    () =>
      Effect.gen(function* () {
        const f = yield* requestFixture;
        const firstOwner = new AbortController();
        const first = f.context("request-1", firstOwner);
        const runtime = yield* f.open(first);
        const running = yield* runtime.run(f.firstInput, first).pipe(Effect.forkScoped);
        yield* f.instance.adapter.nextStart;
        yield* f.instance.adapter.terminal();
        yield* Fiber.join(running);
        firstOwner.abort();
        expect(f.signals[0]?.aborted).toBe(false);
        const input = {
          ...f.instance.adapter.turn,
          runId: RunId.make("run-2"),
          runOrdinal: 2,
          providerTurnOrdinal: 2,
          attemptId: RunAttemptId.make("attempt-2"),
        };
        const secondRef = yield* f.input("input-2", input);
        const second = f.context("request-2");
        const next = yield* runtime.run(secondRef, second).pipe(Effect.forkScoped);
        yield* f.instance.adapter.nextStart;
        const before = f.checks.length;
        const response = yield* Effect.promise(() =>
          f.harness.modelTransport(new Request("https://model.invalid/turn")),
        );
        expect(yield* Effect.promise(() => response.text())).toBe("model");
        const configuration = f.f.configurations.at(-1)!;
        const forwarded = yield* Effect.promise(() =>
          f.harness.modelTransport(new Request(configuration.servers.executor!.url)),
        );
        expect(yield* Effect.promise(() => forwarded.text())).toBe("executor");
        expect(f.checks.slice(before).every((id) => id === "request-2")).toBe(true);
        expect(f.f.forwards.at(-1)?.grant.secret).toBe("request-2");
        yield* f.instance.adapter.terminal(input);
        yield* Fiber.join(next);
        expect(f.nativeOpens).toBe(1);
        expect(f.instance.adapter.calls.filter((call) => call === "start")).toHaveLength(2);
        expect(f.progress).toContain("request-2");
        expect(f.signals[0]?.aborted).toBe(false);
        const idle = yield* Effect.tryPromise({
          try: () => f.harness.modelTransport(new Request("https://model.invalid/idle")),
          catch: () => new HarnessRequestFacetError("denied"),
        }).pipe(Effect.result);
        expect(Result.isFailure(idle)).toBe(true);
        expect(f.f.transportRequests).toHaveLength(1);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "fences actual model, Executor, exec, port and save admissions after the store revokes authority",
    () =>
      Effect.gen(function* () {
        const f = yield* requestFixture;
        let execs = 0;
        let ports = 0;
        let saves = 0;
        f.setHost({
          bindComputer: () =>
            Effect.succeed({
              exec: async () => {
                execs++;
                throw new Error("Unexpected accepted exec");
              },
              port: async () => {
                ports++;
                return { fetch: async () => new Response(null) };
              },
              save: async () => {
                saves++;
                return { commit: "fixture" };
              },
            }),
        });
        const context = f.context("request-1");
        const runtime = yield* f.open(context);
        const running = yield* runtime.run(f.firstInput, context).pipe(Effect.forkScoped);
        yield* f.instance.adapter.nextStart;
        const port = yield* Effect.promise(() => f.harness.computer.port(3000, context.signal));
        expect(ports).toBe(1);
        f.setAllowed(false);
        const rejected = (operation: () => Promise<unknown>) =>
          Effect.tryPromise({
            try: operation,
            catch: () => new HarnessRequestFacetError("denied"),
          }).pipe(Effect.result);
        const configuration = f.f.configurations.at(-1)!;
        expect(
          Result.isFailure(
            yield* rejected(() =>
              f.harness.modelTransport(new Request("https://model.invalid/revoked")),
            ),
          ),
        ).toBe(true);
        expect(
          Result.isFailure(
            yield* rejected(() =>
              f.harness.modelTransport(new Request(configuration.servers.executor!.url)),
            ),
          ),
        ).toBe(true);
        expect(
          Result.isFailure(
            yield* rejected(() =>
              f.harness.computer.exec(
                { executable: "cat", argv: ["cat"], cwd: "/workspace", env: {} },
                context.signal,
                undefined,
              ),
            ),
          ),
        ).toBe(true);
        expect(
          Result.isFailure(yield* rejected(() => f.harness.computer.port(3001, context.signal))),
        ).toBe(true);
        expect(
          Result.isFailure(
            yield* rejected(() => port.fetch(new Request("https://port.invalid/revoked"))),
          ),
        ).toBe(true);
        expect(
          Result.isFailure(yield* rejected(() => f.harness.computer.save(context.signal))),
        ).toBe(true);
        expect(f.f.transportRequests).toHaveLength(0);
        expect(f.f.forwards).toHaveLength(0);
        expect({ execs, ports, saves }).toEqual({ execs: 0, ports: 1, saves: 0 });
        yield* Fiber.interrupt(running);
        expect(f.exports).toHaveLength(0);
      }).pipe(Effect.scoped),
  );

  it.effect("keeps an admitted command inside the request until its exit receipt settles", () =>
    Effect.gen(function* () {
      const f = yield* requestFixture;
      const exited = Promise.withResolvers<{
        exitCode: number;
        signal: number;
        coreDumped: boolean;
      }>();
      const terminalPublished = yield* Deferred.make<void>();
      f.setPublication((item) =>
        item.kind === "provider" && item.event.type === "turn.terminal"
          ? Deferred.succeed(terminalPublished, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      f.setHost({
        bindComputer: () =>
          Effect.succeed({
            exec: async () => ({
              stdin: new WritableStream<Uint8Array>(),
              stdout: new ReadableStream<Uint8Array>(),
              stderr: new ReadableStream<Uint8Array>(),
              exited: exited.promise,
              signal: async () => ({ status: "ok" as const, value: undefined }),
              dispose: async () => {},
            }),
            port: async () => {
              throw new Error("Unused port");
            },
            save: async () => ({ commit: "command-files" }),
          }),
      });
      const context = f.context("request-1");
      const runtime = yield* f.open(context);
      const running = yield* runtime.run(f.firstInput, context).pipe(Effect.forkScoped);
      yield* f.instance.adapter.nextStart;
      yield* Effect.promise(() =>
        f.harness.computer.exec(
          { executable: "cat", argv: ["cat"], cwd: "/workspace", env: {} },
          context.signal,
          undefined,
        ),
      );
      yield* f.instance.adapter.terminal();
      yield* Deferred.await(terminalPublished);
      expect(f.exports).toHaveLength(0);
      exited.resolve({ exitCode: 0, signal: 0, coreDumped: false });
      expect((yield* Fiber.join(running)).status).toBe("completed");
      expect(f.exports[0]?.revision.commit).toBe("command-files");
    }).pipe(Effect.scoped),
  );
});
