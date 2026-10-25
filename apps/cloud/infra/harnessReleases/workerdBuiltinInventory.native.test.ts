import { describe, expect, it } from "vite-plus/test";
import { captureWorkerdBuiltinInventory } from "./workerdBuiltinInventory.ts";

describe("native builtin inventory", () => {
  it("inspects the Workerd personality instead of accepting Node's callable stubs", async () => {
    const result = await captureWorkerdBuiltinInventory([
      { specifier: "crypto", memberPath: ["createHash"] },
      { specifier: "http2", memberPath: ["connect"] },
      { specifier: "net", memberPath: ["connect"] },
      { specifier: "vm", memberPath: ["SourceTextModule"] },
      { specifier: "process", memberPath: ["umask"] },
    ]);
    expect(result).toMatchObject({
      functions: [
        { status: "supported" },
        { status: "unsupported" },
        { status: "conditional" },
        { status: "missing" },
        { status: "supported" },
      ],
      profile: {
        nativeRuntime: {
          runtime: "workerd",
          workerdVersion: "1.20261012.1",
          nodeCompatibilityRevision: "workerd-nodejs-compat@1.20261012.1",
        },
      },
      capture: {
        runtimeClosed: true,
        workerdBinarySha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
  });
});
