import { describe, expect, it } from "vite-plus/test";
import * as NodeModule from "node:module";
import { inspectNodeBuiltinCoverage } from "./nodeBuiltinGate/coverage.ts";
import { captureRuntimeBuiltinSpecifiers } from "./runtimeBuiltinInventory.ts";
import { assertPackagedBuiltinCoverage, scanBuiltinSource } from "./nodeBuiltinGate.ts";

const source = (text: string) => ({ name: "release.mjs", source: text });
describe("release builtin gate", () => {
  it("enumerates imports, exports, dynamic imports and scoped createRequire aliases", () => {
    const scan = scanBuiltinSource(
      source(`
      import {createRequire as make} from 'node:module';
      import 'dns'; export {default} from 'node:dns/promises';
      const load = make(import.meta.url); load('stream/consumers');
      import('node:util/types');
      function unrelated(require) { require('node:cluster'); }
    `),
    );
    expect(scan.requiredSpecifiers).toEqual([
      "dns",
      "node:dns/promises",
      "node:module",
      "node:util/types",
      "stream/consumers",
    ]);
    expect(scan.ambiguities).toEqual([]);
  });

  it("finds bridge facades folded into rebundled CLI code", () => {
    const scan = scanBuiltinSource(
      source(`
      const bridge = globalThis[Symbol.for('signalbox.nodeBridge.v1')];
      bridge.require('dns');
      const load = bridge.require('node:module').createRequire('/release.js');
      load('dns/promises');
      function other(bridge) { bridge.require('node:cluster'); }
    `),
    );
    expect(scan.requiredSpecifiers).toEqual(["dns", "dns/promises", "node:module"]);
  });

  it("rejects unavailable builtin loads through the production gate", async () => {
    await expect(
      assertPackagedBuiltinCoverage([source("process.getBuiltinModule('node:cluster')")]),
    ).rejects.toThrow("NODE_BUILTIN_COVERAGE_FAILED: missing=cluster");
    await expect(
      assertPackagedBuiltinCoverage([
        source("globalThis.process?.getBuiltinModule?.('node:unknown_builtin')"),
      ]),
    ).rejects.toThrow("NODE_BUILTIN_COVERAGE_FAILED: unknown=node:unknown_builtin");
  });

  it("rejects literal builtins behind comma-expression require calls", async () => {
    await expect(
      assertPackagedBuiltinCoverage([
        source(`
      import {createRequire} from 'node:module';
      const load = createRequire(import.meta.url);
      (0, load)('node:cluster');
    `),
      ]),
    ).rejects.toThrow("NODE_BUILTIN_COVERAGE_FAILED: missing=cluster");
  });

  it("tracks optional builtin loads and aliases while respecting shadowed process objects", () => {
    const scan = scanBuiltinSource(
      source(`
      process.getBuiltinModule('dns');
      globalThis.process?.getBuiltinModule?.('async_hooks');
      global.process['getBuiltinModule']('node:stream');
      const p = process; p.getBuiltinModule('util');
      process.getBuiltinModule(selected);
      function unrelated(process, globalThis) {
        process.getBuiltinModule('cluster');
        globalThis.process.getBuiltinModule('dgram');
      }
    `),
    );
    expect(scan.requiredSpecifiers).toEqual(["async_hooks", "dns", "node:stream", "util"]);
    expect(scan.ambiguities.map((item) => [item.kind, item.specifier])).toEqual([
      ["builtin-module", "selected"],
    ]);
  });

  it("reuses CommonJS wrapper and import.meta.require analysis", () => {
    const scan = scanBuiltinSource({
      name: "extracted.cjs",
      format: 2,
      source: `(function(exports,require,module,__filename,__dirname){
      require('dns'); module.require('node:stream');
      import.meta.require('dns/promises');
      function unrelated(require) { require('cluster'); }
    })`,
    });
    expect(scan.requiredSpecifiers).toEqual(["dns", "dns/promises", "node:stream"]);
    expect(scan.ambiguities).toEqual([]);
  });

  it("preserves unresolved computed imports rather than claiming complete static coverage", () => {
    const scan = scanBuiltinSource(
      source(`
      import { createRequire } from 'node:module';
      const load = createRequire(import.meta.url);
      load(plugin); import(entry);
    `),
    );
    expect(scan.ambiguities.map((entry) => [entry.kind, entry.specifier])).toEqual([
      ["dynamic-require", "plugin"],
      ["dynamic-import", "entry"],
    ]);
  });

  it("rejects each missing installed builtin against the actual runtime inventory", async () => {
    const installed = await captureRuntimeBuiltinSpecifiers();
    const scan = scanBuiltinSource(
      source(installed.map((name) => `import ${JSON.stringify(`node:${name}`)};`).join("\n")),
    );
    expect(scan.requiredSpecifiers).toHaveLength(installed.length);
    for (const missing of installed) {
      const report = inspectNodeBuiltinCoverage({
        builtinModules: NodeModule.builtinModules,
        requiredSpecifiers: scan.requiredSpecifiers,
        installedSpecifiers: installed.filter((name) => name !== missing),
      });
      expect(report.status, missing).toBe("fail");
      expect(report.missingBuiltins).toEqual([missing]);
    }
  });

  it("counts no Node imports for a WASM-only loader", () => {
    const scan = scanBuiltinSource(
      source("export const load = async (bytes) => WebAssembly.compile(bytes);"),
    );
    expect(scan.requiredSpecifiers).toEqual([]);
  });
});
