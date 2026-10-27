import { describe, expect, it } from "@effect/vitest";
import {
  HARNESS_C_PRODUCT_CAPABILITY_KEYS,
  HarnessCProductCapabilityError,
  narrowHarnessCProductCapabilities,
} from "../HarnessCProductCapabilities.ts";

const completeCapabilities = () =>
  Object.fromEntries([
    [
      HARNESS_C_PRODUCT_CAPABILITY_KEYS.release,
      { getArtifact() {}, loaderConfig() {}, readArtifact() {} },
    ],
    [HARNESS_C_PRODUCT_CAPABILITY_KEYS.nativeCheckpoint, { read() {} }],
    [
      HARNESS_C_PRODUCT_CAPABILITY_KEYS.access,
      { resolveInitialAccess() {}, resolveTurnAccess() {} },
    ],
    [HARNESS_C_PRODUCT_CAPABILITY_KEYS.programs, { catalog() {}, read() {} }],
    [HARNESS_C_PRODUCT_CAPABILITY_KEYS.machine, { inventory() {} }],
    [HARNESS_C_PRODUCT_CAPABILITY_KEYS.model, { fetch() {} }],
    [HARNESS_C_PRODUCT_CAPABILITY_KEYS.executor, { forward() {} }],
  ]) as unknown as Readonly<Record<string, Fetcher>>;

describe("product bootstrap capabilities", () => {
  it("requires the constructor-owned Worker binding map and every named RPC", () => {
    expect(() => narrowHarnessCProductCapabilities(undefined)).toThrow(
      HarnessCProductCapabilityError,
    );

    const valid = narrowHarnessCProductCapabilities(completeCapabilities());
    expect(typeof valid.release.getArtifact).toBe("function");
    expect(typeof valid.machine.inventory).toBe("function");

    const missingMachine = { ...completeCapabilities() };
    delete (missingMachine as Record<string, unknown>)[HARNESS_C_PRODUCT_CAPABILITY_KEYS.machine];
    expect(() => narrowHarnessCProductCapabilities(missingMachine)).toThrow(
      HarnessCProductCapabilityError,
    );
  });
});
