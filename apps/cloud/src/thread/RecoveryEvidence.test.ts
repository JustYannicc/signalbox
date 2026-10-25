import { CommandId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";

import { recoveryEvidence, withRecoveryInspection } from "./RecoveryEvidence.ts";
import {
  appendSession,
  connect,
  freshDatabase,
  launch,
  owner,
  personal,
  threadId,
  withObject,
} from "./runnerTesting.ts";

describe("recovery drill evidence", () => {
  it.effect(
    "keeps event and opaque native-row prefixes verifiable across object reconstruction",
    () =>
      Effect.gen(function* () {
        const database = freshDatabase();
        const first = yield* withObject(database, (engine, runner, context) =>
          Effect.gen(function* () {
            yield* launch(engine);
            yield* engine.dispatch(
              owner,
              {
                type: "thread.metadata.update",
                commandId: CommandId.make("disposable-title"),
                threadId,
                title: "recovery-drill/native-prefix",
              },
              personal,
            );
            const machine = yield* connect(runner);
            yield* appendSession(context, {
              stream: "claude/session-1",
              offset: 0,
              rows: ['{"type":"thinking","signature":"opaque-signed-reasoning"}'],
            });
            const evidence = yield* recoveryEvidence(owner.userId, ["launch-1"]);
            if (evidence === null || "error" in evidence)
              throw new Error("Missing recovery evidence.");
            expect(evidence.receipts[0]?.receipt?._tag).toBe("accepted");
            expect(evidence.lease.generation).toBe(machine.generation);
            expect(evidence.sessions[0]).toMatchObject({ stream: "claude/session-1", count: 1 });
            const serialized = JSON.stringify(evidence);
            expect(serialized).not.toContain(machine.token);
            expect(serialized).not.toContain("opaque-signed-reasoning");
            expect(serialized).not.toContain("Hello Claude");
            return evidence;
          }).pipe(Effect.provide(context)),
        );
        yield* withObject(database, (_engine, _runner, context) =>
          Effect.gen(function* () {
            yield* appendSession(context, {
              stream: "claude/session-1",
              offset: 1,
              rows: ['{"type":"assistant","text":"after recovery"}'],
            });
            const after = yield* recoveryEvidence(owner.userId, ["launch-1"]);
            if (after === null || "error" in after)
              throw new Error("Missing reconstructed evidence.");
            expect(after.events).toEqual(first.events);
            expect(after.receipts).toEqual(first.receipts);
            expect(after.lease).toEqual(first.lease);
            expect(after.sessions[0]?.hashes.slice(0, 1)).toEqual(first.sessions[0]?.hashes);
            expect(after.sessions[0]?.count).toBe(2);
          }).pipe(Effect.provide(context)),
        );
      }),
  );

  it.effect("does not expose ordinary threads or another owner's disposable thread", () =>
    withObject(freshDatabase(), (engine, _runner, context) =>
      Effect.gen(function* () {
        expect(yield* recoveryEvidence(owner.userId, [])).toBeNull();
        yield* launch(engine);
        expect(yield* recoveryEvidence(owner.userId, [])).toBeNull();
        yield* engine.dispatch(
          owner,
          {
            type: "thread.metadata.update",
            commandId: CommandId.make("disposable-title"),
            threadId,
            title: "recovery-drill/owned",
          },
          personal,
        );
        expect(yield* recoveryEvidence("another-owner", [])).toBeNull();
        expect(yield* recoveryEvidence(owner.userId, [])).not.toBeNull();
      }).pipe(Effect.provide(context)),
    ),
  );

  it.effect("rejects oversized native evidence as data and leaves the engine usable", () =>
    withObject(freshDatabase(), (engine, _runner, context) =>
      Effect.gen(function* () {
        yield* launch(engine);
        yield* engine.dispatch(
          owner,
          {
            type: "thread.metadata.update",
            commandId: CommandId.make("disposable-title"),
            threadId,
            title: "recovery-drill/oversized",
          },
          personal,
        );
        yield* appendSession(context, {
          stream: "claude/large",
          offset: 0,
          rows: ["x".repeat(8_000_001)],
        });
        expect(yield* recoveryEvidence(owner.userId, [])).toEqual({ error: "evidence_limit" });
        yield* engine.dispatch(
          owner,
          {
            type: "thread.metadata.update",
            commandId: CommandId.make("still-usable"),
            threadId,
            title: "recovery-drill/still-usable",
          },
          personal,
        );
        expect((yield* engine.snapshot(owner)).projection.thread.title).toBe(
          "recovery-drill/still-usable",
        );
      }).pipe(Effect.provide(context)),
    ),
  );

  it.effect("lets an in-flight RPC release the engine before closing the input gate", () =>
    withObject(freshDatabase(), (engine, _runner, context) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const locked = yield* Deferred.make<void>();
        const rpcResponse = yield* Deferred.make<void>();
        const queued = yield* Deferred.make<void>();
        const order: Array<string> = [];
        let gateClosed = false;
        const turnStart = yield* engine
          .apply(() =>
            Effect.gen(function* () {
              yield* Deferred.succeed(locked, undefined);
              yield* Deferred.await(rpcResponse);
              order.push("turn committed");
              return { events: [], result: undefined };
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(locked);
        const inspection = yield* Effect.gen(function* () {
          yield* Deferred.succeed(queued, undefined);
          return yield* withRecoveryInspection((inspect) =>
            Effect.gen(function* () {
              gateClosed = true;
              order.push("gate closed");
              try {
                return yield* inspect(owner.userId, []);
              } finally {
                gateClosed = false;
              }
            }),
          );
        }).pipe(Effect.forkChild);
        yield* Deferred.await(queued);
        yield* Effect.yieldNow;
        expect(gateClosed).toBe(false);
        order.push("RPC response delivered");
        yield* Deferred.succeed(rpcResponse, undefined);
        yield* Fiber.join(turnStart);
        yield* Fiber.join(inspection);
        expect(order).toEqual(["RPC response delivered", "turn committed", "gate closed"]);
        expect(gateClosed).toBe(false);
      }).pipe(Effect.provide(context)),
    ),
  );
});
