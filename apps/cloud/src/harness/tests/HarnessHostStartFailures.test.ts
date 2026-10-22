import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { HarnessError } from "../Harness.ts";
import { hostFixture } from "./hostFixture.ts";

const codec = Schema.toCodecJson(HarnessError);

describe("Harness host failed starts", () => {
  it.effect.each([
    { stage: "configuration", cleanupFails: false },
    { stage: "configuration", cleanupFails: true },
    { stage: "turn", cleanupFails: false },
    { stage: "turn", cleanupFails: true },
  ] as const)(
    "preserves $stage failure and closes all owners (cleanup failure=$cleanupFails)",
    ({ stage, cleanupFails }) =>
      Effect.gen(function* () {
        const f = yield* hostFixture;
        const root = new Error("native WASI trap");
        const original = new Error("native setup failed", { cause: root });
        const nativeFailure = new HarnessError({
          operation: "turn",
          message: "native failed",
          cause: original,
        });
        f.setStartup({
          bootstrap: { bytes: 42, state: "written" },
          wasi: "failed",
          exit: null,
          failure: original,
        });
        let nativeClosed = 0;
        let computerClosed = 0;
        let parentClosed = 0;
        let ownerSignal: AbortSignal | undefined;
        const instance = yield* f.make(
          {
            bindComputer: ({ signal }) =>
              Effect.gen(function* () {
                ownerSignal = signal;
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    expect(signal.aborted).toBe(true);
                    computerClosed++;
                  }),
                );
                return {
                  exec: async () => {
                    throw new Error("unused");
                  },
                  port: async () => {
                    throw new Error("unused");
                  },
                  save: async () => ({ commit: "unused" }),
                };
              }),
          },
          Effect.sync(() => {
            parentClosed++;
          }),
        );
        yield* instance.host.seed("assets");
        yield* instance.host.seed("programs");
        const session = yield* instance.open();
        const files = f.acquisitions[0]!.computer.files;
        f.setCleanup(
          Effect.sync(() => {
            nativeClosed++;
            if (cleanupFails) throw new Error("native cleanup failed");
          }),
        );
        if (stage === "configuration") f.failConfiguration(nativeFailure);
        else instance.adapter.setStartGate(Effect.die(original));
        const result = yield* session
          .turn({ turn: instance.adapter.turn, access: f.access("private-access-grant") })
          .pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isSuccess(result)) throw new Error("Expected failed start");
        const error = result.cause.reasons.find(Cause.isFailReason)?.error;
        expect(error).toBeInstanceOf(HarnessError);
        if (!(error instanceof HarnessError)) throw new Error("Expected public HarnessError");
        expect(error.message).toBe("Native MCP configuration or turn start failed.");
        expect(error.nativeStartup).toEqual({
          bootstrap: { bytes: 42, state: "written" },
          wasi: "failed",
          exit: null,
        });
        if (!Cause.isCause(error.cause)) throw new Error("Missing native cause");
        expect(
          error.cause.reasons.some(
            (reason) => Cause.isDieReason(reason) && reason.defect === original,
          ),
        ).toBe(true);
        const encoded = Schema.encodeSync(codec)(error);
        const json = JSON.stringify(encoded);
        expect(json).toContain("native WASI trap");
        expect(json).toContain("native setup failed");
        expect(json).not.toContain("private-access-grant");
        expect(json.includes("native cleanup failed")).toBe(cleanupFails);
        expect(nativeClosed).toBe(1);
        expect(computerClosed).toBe(1);
        expect(parentClosed).toBe(1);
        expect(ownerSignal?.aborted).toBe(true);
        expect(() => files.stat("/bin/bash")).toThrow("disposed");
        const route = f.configurations[0]!.servers.executor!.url;
        yield* Effect.promise(() => expect(f.mcp.fetch(new Request(route))).rejects.toThrow());
        expect(Exit.isFailure(yield* instance.open("next-attempt").pipe(Effect.exit))).toBe(true);
        f.reopen();
        const rows = f.handle.rows(
          "SELECT boot_attempt_id, run_id, error_json FROM harness_host_failures",
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.boot_attempt_id).toBe("boot-1");
        expect(rows[0]?.run_id).toBe(instance.adapter.turn.runId);
        const durable = Schema.decodeUnknownSync(codec)(JSON.parse(String(rows[0]?.error_json)));
        expect(Schema.encodeSync(codec)(durable)).toEqual(encoded);
      }).pipe(Effect.scoped),
  );

  it.effect("drains owners and reports journal failure without losing the startup cause", () =>
    Effect.gen(function* () {
      const f = yield* hostFixture;
      let parentClosed = false;
      const instance = yield* f.make(
        {},
        Effect.sync(() => {
          parentClosed = true;
        }),
      );
      yield* instance.host.seed("assets");
      yield* instance.host.seed("programs");
      const session = yield* instance.open();
      f.failConfiguration(
        new HarnessError({ operation: "turn", message: "original native failure" }),
      );
      f.handle.failOnce((query) => query.startsWith("INSERT INTO harness_host_failures"));
      const result = yield* session
        .turn({ turn: instance.adapter.turn, access: f.access("private-grant") })
        .pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      expect(parentClosed).toBe(true);
      expect(() => f.computers[0]!.stat("/bin/bash")).toThrow("disposed");
      if (Exit.isSuccess(result)) throw new Error("Expected failed start");
      expect(Cause.pretty(result.cause)).toContain("original native failure");
      expect(Cause.pretty(result.cause)).toContain("Injected transaction failure");
      const failure = result.cause.reasons.find(Cause.isFailReason)?.error;
      if (!(failure instanceof HarnessError) || !Cause.isCause(failure.cause))
        throw new Error("Expected a native start error with its causes");
      const journalFailure = failure.cause.reasons.find(
        (reason) =>
          Cause.isFailReason(reason) &&
          reason.error instanceof HarnessError &&
          reason.error.operation === "journal",
      );
      if (journalFailure === undefined || !Cause.isFailReason(journalFailure))
        throw new Error("Expected a separately labeled journal failure");
      expect(journalFailure.error).toMatchObject({
        operation: "journal",
        message: "Harness failure journal write failed.",
      });
      const encoded = Schema.encodeSync(codec)(failure);
      const decoded = Schema.decodeUnknownSync(codec)(JSON.parse(JSON.stringify(encoded)));
      expect(Schema.encodeSync(codec)(decoded)).toEqual(encoded);
    }).pipe(Effect.scoped),
  );

  it.effect("closes the host after failed native acquisition and consumes its attempt", () =>
    Effect.gen(function* () {
      const f = yield* hostFixture;
      const instance = yield* f.make();
      yield* instance.host.seed("assets");
      yield* instance.host.seed("programs");
      f.failAcquisition(true);
      const failed = yield* instance.open().pipe(Effect.exit);
      expect(Exit.isFailure(failed)).toBe(true);
      expect(() => f.computers[0]!.stat("/bin/bash")).toThrow("disposed");
      f.failAcquisition(false);
      expect(Exit.isFailure(yield* instance.open("fresh-attempt").pipe(Effect.exit))).toBe(true);
      expect(f.acquisitions).toHaveLength(1);
      const rows = f.handle.rows("SELECT run_id, error_json FROM harness_host_failures");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.run_id).toBe(null);
      expect(String(rows[0]?.error_json)).toContain("recording open failed");
    }).pipe(Effect.scoped),
  );
});
