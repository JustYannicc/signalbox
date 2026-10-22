import { describe, expect, it } from "@effect/vitest";
import { getNodeBuiltinCapability, markNodeBuiltinCapability } from "../NodeBuiltinCapabilities.ts";

describe("Node builtin capability metadata", () => {
  it("records explicit metadata without replacing or invoking the function", () => {
    let calls = 0;
    const release = () => {
      calls += 1;
      return "6.12.0";
    };

    const marked = markNodeBuiltinCapability(release, {
      status: "supported",
      evidence: "NodeOs.release reads the shared SystemIdentity release value",
    });

    expect(marked).toBe(release);
    expect(calls).toBe(0);
    expect(getNodeBuiltinCapability(release)).toEqual({
      status: "supported",
      evidence: "NodeOs.release reads the shared SystemIdentity release value",
    });
  });

  it("keeps unavailable declarations explicit and immutable", () => {
    const cpus = () => {
      throw new Error("unsupported");
    };
    const declaration = {
      status: "unsupported" as const,
      evidence: "NodeOs.cpus is an unsupported adapter stub",
    };

    markNodeBuiltinCapability(cpus, declaration);
    const recorded = getNodeBuiltinCapability(cpus);

    expect(recorded).toEqual(declaration);
    expect(Object.isFrozen(recorded)).toBe(true);
    expect(() => markNodeBuiltinCapability(cpus, declaration)).not.toThrow();
    expect(() =>
      markNodeBuiltinCapability(cpus, {
        status: "supported",
        evidence: "unverified",
      }),
    ).toThrow("already has different capability metadata");
  });

  it("rejects empty evidence", () => {
    expect(() =>
      markNodeBuiltinCapability(() => undefined, {
        status: "unsupported",
        evidence: "  ",
      }),
    ).toThrow("evidence must be non-empty");
  });
});
