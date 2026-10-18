import { describe, expect, it } from "vite-plus/test";
import { compileForCloud } from "@signalbox/automation-compiler/compileForCloud";
import { prepareWorkflow } from "@signalbox/automation-compiler/prepareWorkflow";
import { finishWorkflow } from "@signalbox/automation-compiler/finishWorkflow";
import { forCloud } from "@signalbox/automation-compiler/forCloud";
import { parseSync, transformSync } from "@signalbox/automation-compiler/oxc";

const sources = [
  `import * as Schema from "effect/Schema";
export const meta = {
  name: "Composition",
  input: Schema.Struct({ name: Schema.String }),
  output: Schema.Struct({ done: Schema.Boolean }),
} as const;
export default workflow(async (w, input) => {
  await w.start("Awaited", input);
  await w.start("Detached", input, { wait: false });
  return { done: true };
});`,
  `export const meta = { name: "Run" } as const;
async function count(value: number) { return value + 1; }
export default workflow(async (w) => await w.run("Count", count, 1));`,
  `export default 1;`,
  `export const meta = { name: "Bad" }; export default workflow(async (w) => {`,
];

describe("compiler phase boundary", () => {
  it.each(sources)(
    "keeps native output and diagnostics after a plain-data round trip",
    (source) => {
      const prepared = JSON.parse(JSON.stringify(prepareWorkflow(source, parseSync))) as ReturnType<
        typeof prepareWorkflow
      >;
      const result = prepared.ok
        ? forCloud(finishWorkflow(prepared.plan, transformSync))
        : prepared;
      expect(result).toEqual(compileForCloud(source));
      if (prepared.ok) {
        expect(Object.keys(prepared.plan).sort()).toEqual([
          "graph",
          "meta",
          "run",
          "script",
          "worker",
        ]);
      }
    },
  );
});
