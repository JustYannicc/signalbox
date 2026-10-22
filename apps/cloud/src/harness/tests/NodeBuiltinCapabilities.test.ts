import { describe, expect, it } from "@effect/vitest";
import {
  getNodeBuiltinCapability as getFromHarness,
  markNodeBuiltinCapability as markFromHarness,
} from "../NodeBuiltinCapabilities.ts";
import {
  getNodeBuiltinCapability as getFromIsolate,
  markNodeBuiltinCapability as markFromIsolate,
} from "../../isolate/NodeBuiltinCapabilities.ts";

describe("harness Node builtin capability exports", () => {
  it("reexports the isolate registry without creating a second registry", () => {
    const callable = () => "linux";
    markFromHarness(callable, {
      status: "supported",
      evidence: "NodeProcess.platform reads the shared SystemIdentity platform value",
    });

    expect(markFromHarness).toBe(markFromIsolate);
    expect(getFromHarness).toBe(getFromIsolate);
    expect(getFromIsolate(callable)).toEqual({
      status: "supported",
      evidence: "NodeProcess.platform reads the shared SystemIdentity platform value",
    });
  });
});
