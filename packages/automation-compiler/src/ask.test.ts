import { describe, expect, it } from "vite-plus/test";

import { compileWorkflow } from "./compileWorkflow.ts";

const compileAsk = (importance: string) =>
  compileWorkflow(`
  export const meta = { name: "Quiet question" } as const;
  export default workflow(async (w) => {
    await w.ask("Ask me later", { options: ["yes", "no"], importance: ${importance} });
  });
`);

describe("ask importance", () => {
  it("compiles low-priority questions", () => {
    const result = compileAsk('"low"');
    expect(result.ok ? result.workflow.graph.nodes[0] : result.diagnostics).toMatchObject({
      type: "step",
      verb: "ask",
    });
  });

  it("rejects unknown literal priorities", () => {
    const result = compileAsk('"normal"');
    expect(result.ok ? [] : result.diagnostics.map((diagnostic) => diagnostic.message)).toContain(
      'importance must be "low" or "high".',
    );
  });
});
