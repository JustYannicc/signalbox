import { expect, it, vi } from "vite-plus/test";
import { ClaudeImportCalibrationFacet } from "./claudeImportCalibrationFacet.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: function DurableObject() {},
  WorkerEntrypoint: function WorkerEntrypoint() {},
  RpcTarget: function RpcTarget() {},
}));

it("refuses every native entry before reading configuration or constructing native state", () => {
  const untouched = new Proxy(
    {},
    {
      get() {
        throw new Error("Native dispatch touched inert state");
      },
    },
  );
  for (const method of ["startFresh", "prepareInert", "run", "loadedPreparedRelease"] as const) {
    expect(() =>
      Reflect.apply(ClaudeImportCalibrationFacet.prototype[method], untouched, []),
    ).toThrow("CLAUDE_INERT_FACET_NATIVE_DISPATCH_FORBIDDEN");
  }
});
