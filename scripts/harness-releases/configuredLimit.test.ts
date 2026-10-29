import { describe, expect, it } from "vite-plus/test";
import {
  assessConfiguredLimitCompletion,
  classifyV8Termination,
  measureColdFirstSuccessfulRpc,
} from "./configuredLimit.ts";

const complete = {
  configuredLimitBytes: 64,
  deltaMaxObservedBytes: 4,
  safetyMarginBytes: 8,
  budgetBytes: 128,
  calibrationComplete: true,
  workloadCompleted: true,
  identityVerified: true,
};

describe("configured-limit completion with measured overshoot", () => {
  it("rejects the observed 96 MiB profile for both budget interpretations before completion", () => {
    for (const budgetBytes of [134_217_728, 128_000_000]) {
      const result = assessConfiguredLimitCompletion({
        configuredLimitBytes: 100_663_296,
        deltaMaxObservedBytes: 101_195_616,
        safetyMarginBytes: 8_388_608,
        budgetBytes,
        calibrationComplete: false,
        workloadCompleted: false,
        identityVerified: true,
      });
      expect(result).toMatchObject({
        status: "rejected",
        assessedBytes: 210_247_520,
        budgetFits: false,
        strictByteBound: false,
      });
    }
  });

  it("requires literal true at every completion boundary", () => {
    for (const field of ["calibrationComplete", "workloadCompleted", "identityVerified"] as const) {
      for (const invalid of [false, "false", "true", 1, {}, undefined]) {
        const input = { ...complete };
        Reflect.set(input, field, invalid);
        const result = assessConfiguredLimitCompletion(input);
        expect(result.status).toBe("pending");
        expect(result[field]).toBe(false);
      }
    }
    expect(assessConfiguredLimitCompletion(complete).status).toBe("passed");
  });

  it("rejects invalid byte arithmetic", () => {
    for (const value of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER])
      expect(() =>
        assessConfiguredLimitCompletion({ ...complete, configuredLimitBytes: value }),
      ).toThrow("Invalid byte budget");
    expect(() => assessConfiguredLimitCompletion({ ...complete, configuredLimitBytes: 0 })).toThrow(
      "Invalid byte budget",
    );
  });
});

describe("V8 termination evidence", () => {
  const evidence = {
    waited: true,
    timedOut: false,
    identityVerified: true,
    allocationRequestVerified: true,
    stderr: "JavaScript heap out of memory",
  };

  it("requires a recorded nonzero exit or nonblank signal", () => {
    for (const exitCode of [undefined, null, 0])
      for (const signal of [undefined, null, "", "   "])
        expect(classifyV8Termination({ ...evidence, exitCode, signal })).toBe(
          "NO_VERIFIED_TERMINATION",
        );
    for (const actual of [{ exitCode: 1 }, { signal: "SIGABRT" }])
      expect(classifyV8Termination({ ...evidence, ...actual })).toBe(
        "V8_HEAP_OOM_PROCESS_TERMINATED",
      );
  });

  it("keeps timeout, missing ownership and unrelated termination separate from V8 OOM", () => {
    for (const change of [
      { timedOut: true },
      { identityVerified: false },
      { allocationRequestVerified: false },
      { stderr: "connection closed" },
    ])
      expect(classifyV8Termination({ ...evidence, exitCode: 1, ...change })).toBe(
        "OTHER_TERMINATION",
      );
    expect(classifyV8Termination({ ...evidence, exitCode: 1, waited: false })).toBe(
      "NO_VERIFIED_TERMINATION",
    );
  });
});

it("times one cold invocation in the parent and labels the result as an upper bound", async () => {
  let calls = 0;
  let invocationStarted = 0n;
  const measured = await measureColdFirstSuccessfulRpc(async () => {
    calls++;
    invocationStarted = process.hrtime.bigint();
    return "actual-rpc-result";
  });
  expect(calls).toBe(1);
  expect(measured.value).toBe("actual-rpc-result");
  expect(measured.timing).toMatchObject({
    interpretation: "startup upper bound",
    exactBootTime: false,
    includesRpc: true,
  });
  const elapsed =
    BigInt(measured.timing.finishedMonotonicNs) - BigInt(measured.timing.startedMonotonicNs);
  expect(elapsed >= 0n).toBe(true);
  expect(BigInt(measured.timing.startedMonotonicNs) <= invocationStarted).toBe(true);
  expect(measured.timing.milliseconds).toBe(Number(elapsed) / 1e6);
});
