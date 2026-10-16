import { AUTOMATION_COMPILED_FORMAT, AutomationCompiled } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { compileForCloud } from "./compileForCloud.ts";

const decodeCompiled = Schema.decodeSync(AutomationCompiled);

describe("compileForCloud", () => {
  it("stamps the format the cloud reads and keeps the worker module", () => {
    const result = compileForCloud(`export const meta = { name: "Hello" } as const;
export default workflow(async (w) => {
  await w.notify("Hi", "there");
});`);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(result.compiled.format).toBe(AUTOMATION_COMPILED_FORMAT);
    expect(result.compiled.meta.name).toBe("Hello");
    expect(result.compiled.workerModule).toMatch(/^export function load\(workflow\) \{/);
    // What goes over the wire decodes as the contract says.
    expect(decodeCompiled(result.compiled)).toEqual(result.compiled);
  });

  it("answers what to fix for a file that doesn't compile", () => {
    const result = compileForCloud("export default 1;");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.length).toBeGreaterThan(0);
  });
});
