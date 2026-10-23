import { describe, expect, it } from "@effect/vitest";
import { analyzeWorkerFactory, rewriteLexicalReferences } from "./worker-factory-analysis.ts";

describe("worker factory source analysis", () => {
  it("collects only free non-intrinsic globals and maps static import bindings", () => {
    const analysis = analyzeWorkerFactory(
      `
import fs, { readFile as read } from "node:fs";
import * as path from "node:path";
import "node:assert";
const local = new Map();
function load(read) { return read(process.env.PATH); }
const use = () => read(fs.promises, path.sep, globalThis);
`,
      "fixture.js",
    );

    expect(analysis.globals).toEqual(["globalThis", "process"]);
    expect(analysis.imports).toEqual([
      '["node:assert","side-effect",""]',
      '["node:fs","default","fs"]',
      '["node:fs","readFile","read"]',
      '["node:path","*","path"]',
    ]);
  });

  it("reports computed access on the global object and its lexical aliases", () => {
    const analysis = analyzeWorkerFactory(
      `
const realm = globalThis;
const first = realm[key];
const second = globalThis[Symbol.for("signalbox.nodeBridge.v1")];
const env = globalThis.process.env[key];
`,
      "fixture.js",
    );

    expect(analysis.computedGlobalAccess).toEqual({
      count: 3,
      sites: [
        { source: "fixture.js", line: 3, column: 15, kind: "alias(realm:globalThis)[identifier]" },
        { source: "fixture.js", line: 4, column: 16, kind: "globalThis[expression]" },
        { source: "fixture.js", line: 5, column: 13, kind: "globalThis.process.env[identifier]" },
      ],
    });
  });

  it("reports direct, aliased, global-property, and function-constructor sites", () => {
    const source = `
const realm = globalThis;
const F = Function;
const F2 = F;
new Function("");
F2("return this");
realm.Function("return 1");
globalThis["Function"]("return 2");
new (() => {}).constructor("return 3");
function local(Function) { return Function("not global"); }
`;
    const analysis = analyzeWorkerFactory(source, "fixture.js");

    expect(analysis.functionConstructors).toEqual({
      count: 5,
      sites: [
        { source: "fixture.js", line: 5, column: 1, kind: "direct-new" },
        { source: "fixture.js", line: 6, column: 1, kind: "alias-call" },
        { source: "fixture.js", line: 7, column: 1, kind: "global-property-call" },
        { source: "fixture.js", line: 8, column: 1, kind: "global-property-call" },
        { source: "fixture.js", line: 9, column: 1, kind: "constructor-property-new" },
      ],
    });
    expect(analysis.globals).not.toContain("Function");
    expect(JSON.stringify(analyzeWorkerFactory(source, "fixture.js"))).toBe(
      JSON.stringify(analysis),
    );
  });

  it("rejects direct and aliased eval calls and with statements, not inert text", () => {
    expect(() =>
      analyzeWorkerFactory('const source = "eval(\\"x\\")";', "fixture.js"),
    ).not.toThrow();
    expect(() => analyzeWorkerFactory('eval("x");', "fixture.js")).toThrow(
      "WORKER_FACTORY_EVAL: fixture.js:1:1",
    );
    expect(() => analyzeWorkerFactory('const e = eval; e("x");', "fixture.js")).toThrow(
      "WORKER_FACTORY_EVAL: fixture.js:1:17",
    );
    expect(() => analyzeWorkerFactory("with (scope) { use(scope); }", "fixture.js")).toThrow(
      "WORKER_FACTORY_WITH: fixture.js:1:1",
    );
  });
});

describe("worker factory lexical reference rewrite", () => {
  it("rewrites imported references by symbol identity without changing shadowed uses", () => {
    const source = `
import { readFile as read } from "node:fs";
const object = { read };
const contents = read("file");
const tag = read\`tag\`;
const property = { read: read };
function shadow(read) { return read("local"); }
export { read };
`;
    const output = rewriteLexicalReferences(
      source,
      new Map([["read", "instance.read(0)"]]),
      "fixture.js",
    );

    expect(output).toContain("const object = { read: instance.read(0) };");
    expect(output).toContain('const contents = (0, instance.read(0))("file");');
    expect(output).toContain("const tag = (0, instance.read(0))`tag`;");
    expect(output).toContain("const property = { read: instance.read(0) };");
    expect(output).toContain('function shadow(read) { return read("local"); }');
    expect(output).toContain("export { read };");
    expect(output).toContain('import { readFile as read } from "node:fs";');
  });
});
