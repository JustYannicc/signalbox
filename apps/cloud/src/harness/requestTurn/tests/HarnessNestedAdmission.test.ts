import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { commandGatewayFixture, exited, readAll } from "../../../computer/commandGatewayTesting.ts";
import { requestFixture } from "./fixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

it.effect("keeps nested command admission through the request and session host wrappers", () =>
  Effect.gen(function* () {
    const attempted = Promise.withResolvers<void>();
    const dispatchStarted = Promise.withResolvers<void>();
    const dispatch = Promise.withResolvers<void>();
    const fixture = yield* Effect.acquireRelease(
      Effect.sync(() =>
        commandGatewayFixture({
          capacityLimit: 1,
          async run(_input, invocation) {
            dispatchStarted.resolve();
            await dispatch.promise;
            invocation.acknowledge();
            return exited(7);
          },
        }),
      ),
      (value) =>
        Effect.promise(async () => {
          value.controller.abort();
          dispatch.resolve();
          await value.close();
        }),
    );
    const reserve = fixture.capacity.reserve.bind(fixture.capacity);
    vi.spyOn(fixture.capacity, "reserve").mockImplementation((...args) => {
      const pending = reserve(...args);
      attempted.resolve();
      return pending;
    });
    const f = yield* requestFixture;
    f.setHost({
      bindComputer: () =>
        Effect.succeed({
          exec: fixture.gateway.exec,
          port: async () => {
            throw new Error("Unused port");
          },
          save: async () => ({ commit: "nested-command" }),
        }),
    });
    const context = f.context("request-1");
    const runtime = yield* f.open(context);
    const running = yield* runtime.run(f.firstInput, context).pipe(Effect.forkScoped);
    yield* f.instance.adapter.nextStart;
    const syntheticRequest = Object.freeze({ codeId: "test-holder", residentBytes: 0 });
    yield* Effect.promise(() =>
      fixture.capacity.run(
        fixture.controller.signal,
        async (execution) => {
          const child = f.harness.computer.exec(
            { executable: "/bin/pwd", argv: ["pwd"], cwd: "/workspace", env: {} },
            fixture.controller.signal,
            { processes: fixture.context.processes, process: fixture.context.identity.handle },
          );
          void child.catch(() => undefined);
          try {
            await attempted.promise;
            // This fake shell acknowledges stop only after nested admission is queued.
            const stopAck = Promise.withResolvers<void>();
            stopAck.resolve();
            await stopAck.promise;
            await execution.handoff();
            await dispatchStarted.promise;
            expect(fixture.capacity.active).toBe(1);
            dispatch.resolve();
            const admitted = await child;
            const [status] = await Promise.all([
              admitted.exited,
              readAll(admitted.stdout),
              readAll(admitted.stderr),
            ]);
            expect(status).toEqual(exited(7));
            await admitted.dispose();
          } finally {
            fixture.controller.abort();
            dispatch.resolve();
            await child.catch(() => undefined);
          }
        },
        { processes: fixture.context.processes, process: fixture.context.identity.handle },
        syntheticRequest,
      ),
    );
    expect(fixture.capacity.active).toBe(0);
    yield* f.instance.adapter.terminal();
    yield* Fiber.join(running);
  }).pipe(Effect.scoped),
);
