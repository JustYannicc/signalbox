// @effect-diagnostics cryptoRandomUUID:off - throwaway secrets only.
import { expect, it } from "@effect/vitest";
import { RunId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";

import { freshDatabase, launch, withObject } from "../runner/runnerTestKit.ts";
import { ThreadStore } from "../ThreadStore.ts";
import { makeEgressDispatch } from "./egressDispatch.ts";

const oldValue = `sk-old-${crypto.randomUUID()}`;
const runId = RunId.make("dispatch-test-run");
const nextValue = `sk-next-${crypto.randomUUID()}`;

it.effect(
  "refuses a dispatch queued behind rotation instead of sending the previous revision",
  () =>
    withObject(freshDatabase(), (engine, _runner, context) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const sql = Context.get(context, SqlClient.SqlClient);
        const store = Context.get(context, ThreadStore);
        yield* store.beginSecretRun(1, runId);
        yield* store
          .registerSecretValues(
            1,
            runId,
            [{ name: "KEY", value: oldValue }],
            [{ name: "KEY", value: oldValue }],
          )
          .pipe(sql.withTransaction);
        const before = yield* store.secretValues;
        let sends = 0;
        const dispatch = yield* makeEgressDispatch({
          send: async () => {
            sends++;
            return new Response("ok");
          },
        }).pipe(Effect.provide(context));
        const written = yield* Deferred.make<void>();
        const commit = yield* Deferred.make<void>();
        const rotation = yield* Effect.gen(function* () {
          yield* store.registerSecretValues(
            1,
            runId,
            [{ name: "KEY", value: nextValue }],
            [{ name: "KEY", value: nextValue }],
          );
          yield* Deferred.succeed(written, undefined);
          yield* Deferred.await(commit);
        }).pipe(sql.withTransaction, Effect.forkChild);
        yield* Deferred.await(written);
        const sending = yield* dispatch(
          new Request("https://approved.example/", { headers: { "x-key": oldValue } }),
          before.revision,
        ).pipe(Effect.forkChild);
        yield* Deferred.succeed(commit, undefined);
        yield* Fiber.join(rotation);
        expect(yield* Fiber.join(sending)).toEqual({ _tag: "stale" });
        expect(sends).toBe(0);
        const current = yield* store.secretValues;
        expect(current.current[0]?.value === nextValue).toBe(true);
        expect(
          (yield* dispatch(new Request("https://approved.example/"), current.revision))._tag,
        ).toBe("sent");
        expect(sends).toBe(1);
      }),
    ),
);

it.effect("allows rotation while an already-dispatched request waits on its destination", () =>
  withObject(freshDatabase(), (engine, _runner, context) =>
    Effect.gen(function* () {
      yield* launch(engine);
      const sql = Context.get(context, SqlClient.SqlClient);
      const store = Context.get(context, ThreadStore);
      yield* store.beginSecretRun(1, runId);
      yield* store
        .registerSecretValues(
          1,
          runId,
          [{ name: "KEY", value: oldValue }],
          [{ name: "KEY", value: oldValue }],
        )
        .pipe(sql.withTransaction);
      const before = yield* store.secretValues;
      const started = Promise.withResolvers<void>();
      const response = Promise.withResolvers<Response>();
      const dispatch = yield* makeEgressDispatch({
        send: () => {
          started.resolve();
          return response.promise;
        },
      }).pipe(Effect.provide(context));
      const pending = yield* dispatch(
        new Request("https://approved.example/"),
        before.revision,
      ).pipe(Effect.forkChild);
      yield* Effect.promise(() => started.promise);
      // This must finish without the remote host replying first.
      yield* store
        .registerSecretValues(
          1,
          runId,
          [{ name: "KEY", value: nextValue }],
          [{ name: "KEY", value: nextValue }],
        )
        .pipe(sql.withTransaction);
      const rotated = yield* store.secretValues;
      expect(rotated.revision).toBe(before.revision + 1);
      expect(rotated.current[0]?.value === nextValue).toBe(true);
      response.resolve(new Response("ok"));
      expect((yield* Fiber.join(pending))._tag).toBe("sent");
    }),
  ),
);
