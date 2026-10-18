import { describe, expect, it } from "@effect/vitest";
import { verificationErrors } from "./verify.ts";

describe("isolate proof verification", () => {
  it("fails a successful HTTP response containing a Worker Loader or fixture error", () => {
    expect(
      verificationErrors([{ path: "/smoke", response: { error: "isolate exhausted memory" } }]),
    ).toEqual(["/smoke: isolate exhausted memory"]);
    expect(
      verificationErrors([{ path: "/smoke", response: { status: 200, result: { ok: false } } }]),
    ).toEqual(["/smoke: behavioral assertion failed"]);
  });

  it("fails lost worker capacity below ten while leaving the eleventh as a measurement", () => {
    expect(
      verificationErrors([
        { scenario: "worker-handles", count: 10, response: { results: [{ ok: false }] } },
        { scenario: "worker-handles", count: 11, response: { results: [{ ok: false }] } },
      ]),
    ).toEqual(["worker-handles: worker admission failed below the production concurrency bound"]);
  });

  it("checks JSPI and the generated value while preserving unsupported telemetry as evidence", () => {
    expect(
      verificationErrors([
        { path: "/status", status: 200, result: { memoryUsage: { available: false } } },
        {
          path: "/capabilities",
          status: 200,
          result: {
            functionConstructor: { ok: true },
            wasm: { ok: true },
            jspi: { ok: false },
          },
        },
        {
          scenario: "request-time-codegen",
          generatedValue: 42,
          response: { status: 200, result: { value: 41 } },
        },
      ]),
    ).toEqual([
      "/capabilities: jspi failed",
      "request-time-codegen: generated code returned the wrong value",
    ]);
  });
});
