import { describe, expect, it } from "vite-plus/test";
import { assertPackagedBuiltinCoverage, scanBuiltinSource } from "../nodeBuiltinGate.ts";

const inventory = {
  modules: ["os", "fs", "events", "module"],
  functions: [
    {
      specifier: "module",
      memberPath: ["createRequire"],
      status: "supported" as const,
      evidence: "test capability",
    },
    {
      specifier: "os",
      memberPath: ["release"],
      status: "supported" as const,
      evidence: "test capability",
    },
    {
      specifier: "fs",
      memberPath: ["readFileSync"],
      status: "supported" as const,
      evidence: "test capability",
    },
    {
      specifier: "events",
      memberPath: [],
      status: "supported" as const,
      evidence: "test capability",
    },
  ],
  profile: {
    systemIdentity: {},
    processIdentity: {},
    filesystem: { posixPolicy: false, setUmask: false },
    cpu: { execution: false, processAccounting: false },
  },
};

describe("reassigned builtin aliases", () => {
  it.each([
    [
      "module branches",
      'let selected = require("os"); if (flag) selected = require("fs"); selected.readFileSync("/file");',
    ],
    [
      "member branches",
      'let selected = require("os").release; if (flag) selected = require("fs").readFileSync; selected();',
    ],
    [
      "ordinary replacement",
      'let selected = require("os"); if (flag) selected = custom; selected.release();',
    ],
    [
      "callable module",
      'let selected = require("events"); if (flag) selected = custom; new selected();',
    ],
    [
      "duplicate var initializer",
      'var selected = require("os"); var selected = require("fs"); selected.readFileSync("/file");',
    ],
    ["require loader", 'let loader = require; if (flag) loader = custom; loader("os").release();'],
    [
      "created loader",
      'import { createRequire } from "module"; let loader = createRequire(import.meta.url); if (flag) loader = custom; loader("os").release();',
    ],
    [
      "bridge loader",
      'const bridge = globalThis[Symbol.for("signalbox.nodeBridge.v1")]; let loader = bridge.require; if (flag) loader = custom; loader("os").release();',
    ],
    [
      "bridge object",
      'let bridge = globalThis[Symbol.for("signalbox.nodeBridge.v1")]; if (flag) bridge = custom; bridge.require("os").release();',
    ],
    [
      "awaited import",
      'async function use() { let loaded = import("os"); if (flag) loaded = custom; (await loaded).release(); }',
    ],
    [
      "import callback",
      'let loaded = import("os"); if (flag) loaded = custom; loaded.then(os => os.release());',
    ],
  ])("keeps %s ambiguous instead of trusting one assignment", async (_name, text) => {
    const input = { name: "branch.js", source: text };
    const scan = scanBuiltinSource(input);
    expect(scan.functionAmbiguities.length).toBeGreaterThan(0);
    const result = assertPackagedBuiltinCoverage([input], inventory);
    if (scan.functionAmbiguities.some(({ kind }) => kind === "dynamic-builtin-loader-call")) {
      await expect(result).rejects.toThrow("unresolved-function-calls=");
    } else {
      await expect(result).resolves.toMatchObject({
        status: "pass",
        functionAmbiguities: expect.arrayContaining([
          expect.objectContaining({ severity: "warning" }),
        ]),
      });
    }
  });

  it.each([
    'loader.call(null, "os").release();',
    'loader.apply(null, ["os"]).release();',
    'loader.bind(null)("os").release();',
    'loader.bind(null, "os")().release();',
    'const invoke = loader.call; invoke(null, "os").release();',
    'loader[operation](null, "os").release();',
  ])("rejects unresolved loader prototype invocation: %s", async (invocation) => {
    for (const initialization of [
      "let loader = require; if (flag) loader = custom;",
      "const loader = require;",
      'import { createRequire } from "module"; const loader = createRequire(import.meta.url);',
    ]) {
      const input = { name: "loader-prototype.js", source: initialization + invocation };
      const scan = scanBuiltinSource(input);
      expect(scan.functionAmbiguities.length).toBeGreaterThan(0);
      await expect(assertPackagedBuiltinCoverage([input], inventory)).rejects.toThrow(
        "unresolved-function-calls=",
      );
    }
  });

  it.each([
    ['require = custom; require("os").release();'],
    ['module = custom; module.require("os").release();'],
  ])("keeps reassigned CommonJS wrapper loaders ambiguous: %s", async (body) => {
    const input = {
      name: "wrapper.js",
      format: 2,
      source: `(function(exports,require,module,__filename,__dirname){${body}})`,
    };
    const scan = scanBuiltinSource(input);
    expect(scan.functionAmbiguities.length).toBeGreaterThan(0);
    await expect(assertPackagedBuiltinCoverage([input], inventory)).rejects.toThrow(
      "unresolved-function-calls=",
    );
  });

  it("recognizes one delayed initialization without treating it as an overwrite", async () => {
    const input = {
      name: "delayed.js",
      source: 'let selected; selected = require("os"); selected.release();',
    };
    const scan = scanBuiltinSource(input);
    expect(scan.requiredFunctions).toContainEqual(
      expect.objectContaining({ specifier: "os", memberPath: ["release"] }),
    );
    expect(scan.functionAmbiguities).toEqual([]);
    await expect(assertPackagedBuiltinCoverage([input], inventory)).resolves.toMatchObject({
      status: "pass",
    });
  });
});
