import ts from "typescript-legacy";
import { expect, it } from "vite-plus/test";
import { applySourceEdits } from "../../claude-bunfs/source-edits.ts";
import { restoreWorkerFactoryReads } from "./workerFactoryReads.ts";

const exports = new Map([
  [0, "fs"],
  [1, "init"],
]);
const parse = (source: string) =>
  ts.createSourceFile("main.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

it.each([
  "const r=i=>instance.read(i);r(1);r(0).writeFileSync('x','y');",
  "instance.read(1);instance.read(0).writeFileSync('x','y');",
])("restores compact and retained long readers without hiding the builtin call: %s", (source) => {
  const restored = restoreWorkerFactoryReads(parse(source), "instance", exports);
  expect([...restored.used]).toEqual([1, 0]);
  expect(applySourceEdits(source, restored.edits)).toBe(
    "__signalboxAnalysis1;__signalboxAnalysis0.writeFileSync('x','y');",
  );
});

it.each([
  "let r=i=>instance.read(i);r(0);",
  "const r=async i=>instance.read(i);r(0);",
  "const r=(i=0)=>instance.read(i);r(0);",
  "const r=(...i)=>instance.read(i);r(0);",
  "const r=i=>instance.read(i+1);r(0);",
  "const r=i=>(sideEffect(),instance.read(i));r(0);",
  'const r=i=>instance["read"](i);r(0);',
  'instance["read"](0);',
  "const r=i=>instance.read.call(instance,i);r(0);",
  "const r=i=>instance.read(i);const leaked=instance;",
  "const r=i=>instance.read(i);const escaped=r;",
  "const r=i=>instance.read(i);function shadow(r){return r(0)}",
  "const r=i=>instance.read(i);r(index);",
  "const r=i=>instance.read(i);r(99);",
  "const r=i=>instance.read(i);r(0,1);",
])("rejects a changed reader that cannot be restored faithfully: %s", (source) => {
  expect(() => restoreWorkerFactoryReads(parse(source), "instance", exports)).toThrow(
    "NODE_BUILTIN_WORKER_FACTORY_SHAPE_CHANGED",
  );
});
