import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { checkCallSpreads, findUnboundedCallSpreads } from "./callSpreadGate.ts";

it.each([
  "edits.push(...reads.edits)",
  "Math.max(...values)",
  "items.concat(...parts)",
  "new Thing(...values)",
  "call?.(...values)",
  "call(...(values as number[]))",
  "call(...(values satisfies number[])!)",
  "call(...[1, ...values])",
])("rejects unbounded arguments: %s", (source) => {
  expect(findUnboundedCallSpreads(source)).toHaveLength(1);
});

it.each([
  "call(...[1, 2, 3])",
  "call(...([1, 2] as const))",
  "new Thing(...[])",
  "const copy = [...values]; const object = {...input}",
  "call([1, ...values])",
  "call(...[[...values]])",
  'const text = "push(...values)"; // call(...values)',
])("allows bounded arguments and non-call spreads: %s", (source) => {
  expect(findUnboundedCallSpreads(source)).toEqual([]);
});

it("reports nested script paths and source positions", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "call-spread-gate-"));
  try {
    await NodeFSP.mkdir(NodePath.join(root, "nested"));
    await NodeFSP.writeFile(NodePath.join(root, "nested", "input.mts"), "// header\nf(...items)");
    await NodeFSP.writeFile(NodePath.join(root, "asset.txt"), "f(...items)");
    expect(await checkCallSpreads(root)).toEqual([
      { file: NodePath.join("nested", "input.mts"), line: 2, column: 3 },
    ]);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
