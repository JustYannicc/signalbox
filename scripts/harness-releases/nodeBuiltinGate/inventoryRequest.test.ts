import { describe, expect, it } from "vite-plus/test";
import { inspectPackagedBuiltinCoverage, scanBuiltinSource } from "../nodeBuiltinGate.ts";
import {
  builtinInventoryRequestSha256,
  captureBuiltinInventoryRequest,
  createBuiltinInventoryRequest,
} from "./inventoryRequest.ts";

const source = {
  name: "entry.mjs",
  source: "import {readFileSync} from 'node:fs'; readFileSync('x');",
};
const request = () => createBuiltinInventoryRequest([scanBuiltinSource(source)]);
const inventory = () => ({
  modules: ["fs"],
  functions: [],
  profile: {
    systemIdentity: {},
    processIdentity: {},
    filesystem: { posixPolicy: false, setUmask: false },
    cpu: { execution: false, processAccounting: false },
  },
  capture: { inventoryRequestSha256: builtinInventoryRequestSha256(request()) },
});

describe("separate builtin inventory stage", () => {
  it("rejects a changed request before creating a runtime", async () => {
    const prepared = request();
    await expect(
      captureBuiltinInventoryRequest(
        { ...prepared, functions: [] },
        builtinInventoryRequestSha256(prepared),
      ),
    ).rejects.toThrow("NODE_BUILTIN_INVENTORY_REQUEST_CHANGED");
  });

  it("uses a supplied snapshot without claiming unmeasured function support", async () => {
    const result = await inspectPackagedBuiltinCoverage([source], inventory());
    expect(result.runtimeCapture).toEqual(inventory().capture);
    expect(result.requiredFunctions).toMatchObject([{ status: "unknown" }]);
  });

  it("rejects source changes even when the requested builtin calls are unchanged", async () => {
    await expect(
      inspectPackagedBuiltinCoverage(
        [{ ...source, source: `${source.source}\nexport const extra=1;` }],
        inventory(),
      ),
    ).rejects.toThrow("NODE_BUILTIN_INVENTORY_SOURCE_CHANGED");
  });
});
