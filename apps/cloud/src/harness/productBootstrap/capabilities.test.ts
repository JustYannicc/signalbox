import { describe, expect, it } from "@effect/vitest";
import {
  HARNESS_C_PRODUCT_CAPABILITY_KEYS,
  HarnessCProductCapabilityError,
  narrowHarnessCProductCapabilities,
  productReleaseBindings,
} from "../HarnessCProductCapabilities.ts";

const completeCapabilities = () =>
  Object.fromEntries([
    [
      HARNESS_C_PRODUCT_CAPABILITY_KEYS.release,
      { getArtifact() {}, loaderConfig() {}, readArtifact() {}, readArtifactChunk() {} },
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
  it("routes bounded artifact reads through the release chunk RPC", async () => {
    const calls: unknown[][] = [];
    const service = {
      async getArtifact() {
        return null;
      },
      async loaderConfig() {
        return {
          trustedComputer: { sourceIdentity: "source", manifestSha256: "0".repeat(64) },
          maxPreparedModuleBytes: 128_000_000,
        };
      },
      async readArtifact() {
        throw new Error("Full artifact read was used.");
      },
      async readArtifactChunk(...args: unknown[]) {
        calls.push(args);
        return new Uint8Array([1, 2, 3]);
      },
    };
    const bindings = await productReleaseBindings("codex", service);
    const options = await bindings.loadOptions();
    const range = options.source.readRange;
    if (range === undefined) throw new Error("Release source did not expose range reads.");

    expect(await range("sha256:artifact", "codex/engine.wasm", 0, 3)).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(calls).toEqual([["sha256:artifact", "codex/engine.wasm", 0, 3]]);
  });

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
