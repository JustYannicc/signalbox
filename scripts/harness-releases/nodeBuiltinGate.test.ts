import { describe, expect, it } from "vite-plus/test";
import * as NodeModule from "node:module";
import { inspectNodeBuiltinCoverage } from "./nodeBuiltinGate/coverage.ts";
import { captureRuntimeBuiltinSpecifiers } from "./runtimeBuiltinInventory.ts";
import { inspectInstalledBuiltinSources, scanBuiltinSource } from "./nodeBuiltinGate.ts";

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

  it("fails missing and unknown builtins even when aliases or cached bundles are used", () => {
    const report = inspectInstalledBuiltinSources(
      [source("import 'node:dns'; require('dns/promises'); import('node:unknown_builtin');")],
      { dns: {} },
    );
    expect(report.status).toBe("fail");
    expect(report.missingBuiltins).toEqual(["dns/promises"]);
    expect(report.unknownBuiltinSpecifiers).toEqual(["node:unknown_builtin"]);
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
