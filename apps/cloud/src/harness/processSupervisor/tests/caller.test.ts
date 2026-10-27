import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect, it } from "@effect/vitest";
import { HarnessProcessResumeError } from "../../HarnessProcessResume.ts";
import { fixture, initial, turn } from "./ports.fixture.ts";
import { realResume, resumeInput, resumeResult } from "./cResume.fixture.ts";

describe("HarnessProcessSupervisor C caller composition", () => {
  it.effect(
    "persists intent before delegating an authoritative reset through real public C resume",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const calls: string[] = [];
        const c = realResume(initial.checkpoint, calls);
        const supervisor = yield* f.open({
          caller: {
            ...f.caller,
            processResume: {
              resume: (input) =>
                Effect.gen(function* () {
                  expect(f.storage.read()).toMatchObject({
                    phase: "resuming",
                    operationId: input.operationId,
                    attempt: 1,
                  });
                  return yield* c.resume(input);
                }),
            },
          },
        });
        const running = yield* supervisor.run(turn).pipe(Effect.forkScoped);
        const ordinary = yield* f.next;
        yield* f.send(ordinary.execution, "platform-reset");
        const resumed = yield* f.next;
        expect(resumed.execution).toEqual({
          turn,
          checkpoint: initial.checkpoint,
          incarnation: { generation: 2, facetNonce: "facet-2" },
          mode: "resume",
        });
        expect(calls).toEqual([
          "fence",
          "drain",
          "authority",
          "native-session",
          "checkpoint",
          "prepare",
          "verify",
          "persist-prepared",
          "publish",
          "activate",
        ]);
        yield* f.finish(resumed);
        expect(yield* Fiber.join(running)).toMatchObject({ _tag: "Completed" });
        const durable = JSON.stringify(f.storage.writes);
        expect(durable).not.toContain("controlKey");
        expect(durable).not.toContain("publisherKey");
        expect(durable).not.toContain("targetPreparedRelease");
      }),
  );

  it.effect("leaves indeterminate stop/publication authority with C and refuses retry", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const calls: string[] = [];
      const supervisor = yield* f.open({
        caller: {
          ...f.caller,
          processResume: realResume(initial.checkpoint, calls, {
            awaitDrain: () => Effect.succeed({ _tag: "indeterminate" }),
          }),
        },
      });
      const running = yield* supervisor.run(turn).pipe(Effect.forkScoped);
      yield* f.send((yield* f.next).execution, "reset");
      const blocked = yield* Fiber.join(running);
      expect(blocked).toMatchObject({
        reason: "resume-failed",
        recovery: "reconcile",
        failedRestarts: 1,
        resume: { stage: "settlement", reason: "indeterminate", recovery: "recorded" },
      });
      expect(calls).toEqual(["fence", "authority", "recovery"]);
      expect(yield* supervisor.retry({ requestId: "retry", turnId: turn.turnId })).toEqual(blocked);
      expect(f.intents).toHaveLength(1);
    }),
  );

  it.effect.each([
    "native-session",
    "checkpoint",
    "reused-incarnation",
    "generation",
    "operation",
  ] as const)("rejects C output with a mismatched %s", (changed) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const supervisor = yield* f.open({
        caller: {
          ...f.caller,
          processResume: {
            resume: (input) =>
              Effect.sync(() => {
                const result = structuredClone(resumeResult(input, initial.checkpoint));
                const snapshot = result.publication.supervisor.snapshot;
                if (changed === "native-session") Reflect.set(snapshot, "nativeSessionId", "wrong");
                if (changed === "checkpoint")
                  Reflect.set(snapshot, "checkpoint", {
                    ...snapshot.checkpoint,
                    checkpointId: "incomplete-turn",
                  });
                if (changed === "reused-incarnation")
                  Reflect.set(
                    result.preparedFacet.identity,
                    "incarnationNonce",
                    initial.incarnation.facetNonce,
                  );
                if (changed === "generation") Reflect.set(snapshot, "generation", 1);
                if (changed === "operation")
                  Reflect.set(result.publication.receipt, "operationId", "wrong");
                return result;
              }),
          },
        },
      });
      const running = yield* supervisor.run(turn).pipe(Effect.forkScoped);
      yield* f.send((yield* f.next).execution, "reset");
      expect(yield* Fiber.join(running)).toMatchObject({
        reason: "identity-mismatch",
        recovery: "reconcile",
      });
      expect(f.turns).toHaveLength(1);
      expect(f.storage.read()?.checkpoint).toEqual(initial.checkpoint);
    }),
  );

  it.effect.each(["operation", "publisher", "generation"] as const)(
    "rejects a caller-built operation with stale %s before calling C",
    (changed) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const supervisor = yield* f.open({
          caller: {
            ...f.caller,
            prepareResume: (intent) =>
              Effect.sync(() => {
                const input = resumeInput(intent);
                if (changed === "operation") return { ...input, operationId: "wrong" };
                if (changed === "generation") return { ...input, expectedFacetGeneration: 9 };
                return { ...input, publisher: { ...input.publisher, facetNonce: "wrong" } };
              }),
          },
        });
        const running = yield* supervisor.run(turn).pipe(Effect.forkScoped);
        yield* f.send((yield* f.next).execution, "reset");
        expect(yield* Fiber.join(running)).toMatchObject({ reason: "identity-mismatch" });
        expect(f.resumes).toHaveLength(0);
      }),
  );

  it.effect(
    "records a lost publication reply without storing error secrets or retrying the RPC",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        let calls = 0;
        const supervisor = yield* f.open({
          caller: {
            ...f.caller,
            processResume: {
              resume: () =>
                Effect.suspend(() => {
                  calls++;
                  return Effect.fail(
                    new HarnessProcessResumeError({
                      stage: "publication",
                      reason: "driver-failed",
                      recoverable: true,
                      recovery: "recorded",
                      cause: new Error("secret-must-not-be-persisted"),
                    }),
                  );
                }),
            },
          },
        });
        const running = yield* supervisor.run(turn).pipe(Effect.forkScoped);
        yield* f.send((yield* f.next).execution, "reset");
        const blocked = yield* Fiber.join(running);
        const replacement = yield* f.open();
        expect(yield* replacement.run(turn)).toEqual(blocked);
        expect(yield* replacement.retry({ requestId: "retry", turnId: turn.turnId })).toEqual(
          blocked,
        );
        expect(calls).toBe(1);
        expect(f.resumes).toHaveLength(0);
        expect(JSON.stringify(f.storage.writes)).not.toContain("secret-must-not-be-persisted");
      }),
  );
});
