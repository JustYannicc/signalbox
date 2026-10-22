import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { HarnessError } from "../Harness.ts";
import { makeReleaseChunkOmittedFailure } from "../HarnessProcessLifetime.ts";

const harnessErrorCodec = Schema.toCodecJson(HarnessError);
const encodeHarnessError = Schema.encodeSync(harnessErrorCodec);
const decodeHarnessError = Schema.decodeUnknownSync(harnessErrorCodec);
const isHarnessError = Schema.is(HarnessError);

const reasonAt = (cause: Cause.Cause<unknown>, index: number): Cause.Reason<unknown> => {
  const reason = cause.reasons[index];
  if (reason === undefined) throw new Error(`Missing Cause reason ${index}`);
  return reason;
};

const failCause = () =>
  Cause.fromReasons([
    Cause.makeFailReason(
      new TypeError("Native MCP configuration failed", {
        cause: new Error("WASI import failed", { cause: "missing host function" }),
      }),
    ),
    Cause.makeDieReason(
      new Error("Error cause contains an Effect Cause", {
        cause: Cause.fail(new Error("nested error", { cause: "nested root" })),
      }),
    ),
    Cause.makeFailReason(
      new HarnessError({
        operation: "turn",
        message: "Nested adapter failure.",
        cause: Cause.fail(
          new Error("outer provider error", { cause: new Error("inner transport error") }),
        ),
      }),
    ),
    Cause.makeInterruptReason(17),
  ]);

const startupFailure = () =>
  new Error("WASI startup failed", {
    cause: new Error("bootstrap rejected", { cause: "invalid module" }),
  });

const cleanupFailure = () =>
  Cause.fromReasons([
    Cause.makeDieReason(
      new AggregateError(
        [
          new Error("session dispose failed", { cause: "session scope closed" }),
          new Error("product owner revoke failed"),
        ],
        "Multiple cleanup failures",
        { cause: Cause.fail(new Error("finalizer failure")) },
      ),
    ),
    Cause.makeFailReason(new Error("scope revocation failed")),
  ]);

const failure = () =>
  new HarnessError({
    operation: "open",
    message: "Native MCP configuration failed.",
    cause: Cause.fromReasons([
      ...failCause().reasons,
      Cause.makeDieReason(startupFailure()),
      ...cleanupFailure().reasons,
    ]),
    nativeStartup: {
      bootstrap: { bytes: 64, state: "failed" },
      wasi: "failed",
      exit: { exitCode: 126, signal: 0, coreDumped: false },
    },
  });

describe("Harness failure details", () => {
  it("round-trips typed release omission details and trace", () => {
    const cause = makeReleaseChunkOmittedFailure({
      code: "RELEASE_CHUNK_OMITTED",
      inputPath: "bun-graph:/modules/lazy.js",
      tier: "configuration",
    });
    const original = new HarnessError({
      operation: "events",
      message: "A release module was omitted.",
      cause,
    });
    const durable = JSON.parse(JSON.stringify(encodeHarnessError(original)));
    const recovered = decodeHarnessError(durable);

    expect(recovered.cause).toMatchObject({
      _tag: "ReleaseChunkOmittedFailure",
      code: "RELEASE_CHUNK_OMITTED",
      inputPath: "bun-graph:/modules/lazy.js",
      tier: "configuration",
      message: "Release module was omitted.",
      stack: expect.stringContaining("Release module was omitted."),
    });
    expect(encodeHarnessError(recovered)).toEqual(durable);
  });

  it("round-trips every Effect Cause reason, nested errors, WASI startup, and cleanup failures", () => {
    const original = failure();
    const json = JSON.stringify(encodeHarnessError(original));
    const durable = JSON.parse(json);
    const recovered = decodeHarnessError(durable);
    expect(encodeHarnessError(recovered)).toEqual(durable);

    expect(Cause.isCause(recovered.cause)).toBe(true);
    if (!Cause.isCause(recovered.cause)) throw new Error("Effect Cause was not restored");
    expect(recovered.cause.reasons.map((reason) => reason._tag)).toEqual([
      "Fail",
      "Die",
      "Fail",
      "Interrupt",
      "Die",
      "Die",
      "Fail",
    ]);
    const first = reasonAt(recovered.cause, 0);
    expect(Cause.isFailReason(first)).toBe(true);
    if (!Cause.isFailReason(first)) throw new Error("First reason was not a typed failure");
    expect(first.error).toMatchObject({
      name: "TypeError",
      message: "Native MCP configuration failed",
      stack: expect.stringContaining("Native MCP configuration failed"),
      cause: expect.objectContaining({
        message: "WASI import failed",
        cause: "missing host function",
      }),
    });

    const causeInError = reasonAt(recovered.cause, 1);
    expect(Cause.isDieReason(causeInError)).toBe(true);
    if (!Cause.isDieReason(causeInError)) throw new Error("Second reason was not a defect");
    expect(causeInError.defect).toBeInstanceOf(Error);
    if (!(causeInError.defect instanceof Error)) throw new Error("Expected an Error defect");
    expect(Cause.isCause(causeInError.defect.cause)).toBe(true);
    if (!Cause.isCause(causeInError.defect.cause))
      throw new Error("Effect Cause inside Error.cause was not restored");
    const deepError = reasonAt(causeInError.defect.cause, 0);
    expect(Cause.isFailReason(deepError)).toBe(true);
    if (!Cause.isFailReason(deepError)) throw new Error("Nested reason was not a failure");
    expect(deepError.error).toMatchObject({ message: "nested error", cause: "nested root" });

    const nestedHarnessFailure = reasonAt(recovered.cause, 2);
    expect(Cause.isFailReason(nestedHarnessFailure)).toBe(true);
    if (!Cause.isFailReason(nestedHarnessFailure))
      throw new Error("Third reason was not a typed failure");
    expect(isHarnessError(nestedHarnessFailure.error)).toBe(true);
    if (!isHarnessError(nestedHarnessFailure.error))
      throw new Error("Nested HarnessError was not restored");
    expect(Cause.isCause(nestedHarnessFailure.error.cause)).toBe(true);
    if (!Cause.isCause(nestedHarnessFailure.error.cause))
      throw new Error("Nested HarnessError Cause was not restored");
    const providerError = reasonAt(nestedHarnessFailure.error.cause, 0);
    expect(Cause.isFailReason(providerError)).toBe(true);
    if (!Cause.isFailReason(providerError)) throw new Error("Expected provider error reason");
    expect(providerError.error).toMatchObject({
      message: "outer provider error",
      cause: expect.objectContaining({ message: "inner transport error" }),
    });

    expect(recovered.nativeStartup).toEqual({
      bootstrap: { bytes: 64, state: "failed" },
      wasi: "failed",
      exit: { exitCode: 126, signal: 0, coreDumped: false },
    });
    const wasiFailure = reasonAt(recovered.cause, 4);
    if (!Cause.isDieReason(wasiFailure)) throw new Error("Expected WASI failure");
    expect(wasiFailure.defect).toMatchObject({
      message: "WASI startup failed",
      cause: expect.objectContaining({
        message: "bootstrap rejected",
        cause: "invalid module",
      }),
    });

    const cleanupDefect = reasonAt(recovered.cause, 5);
    expect(Cause.isDieReason(cleanupDefect)).toBe(true);
    if (!Cause.isDieReason(cleanupDefect)) throw new Error("First cleanup reason was not a defect");
    expect(cleanupDefect.defect).toBeInstanceOf(AggregateError);
    if (!(cleanupDefect.defect instanceof AggregateError))
      throw new Error("Aggregate cleanup failure was not restored");
    expect(cleanupDefect.defect.message).toBe("Multiple cleanup failures");
    expect(cleanupDefect.defect.errors).toHaveLength(2);
    expect(cleanupDefect.defect.errors[0]).toMatchObject({
      message: "session dispose failed",
      cause: "session scope closed",
    });
    expect(Cause.isCause(cleanupDefect.defect.cause)).toBe(true);
  });

  it("keeps legacy arbitrary cause values", () => {
    const legacyCause = { kind: "legacy", detail: { attempt: 3 } };
    const original = new HarnessError({
      operation: "turn",
      message: "Legacy failure.",
      cause: legacyCause,
    });

    const recovered = decodeHarnessError(encodeHarnessError(original));

    expect(recovered.cause).toEqual(legacyCause);
  });
});
