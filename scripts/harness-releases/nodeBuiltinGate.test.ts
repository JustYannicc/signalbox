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

  it.each([
    "const p = process.getBuiltinModule('process'); p.getBuiltinModule('cluster');",
    "const m = process.getBuiltinModule('node:module'); const r = m.createRequire(import.meta.url); r('cluster');",
    "const get = process.getBuiltinModule; const p = get('process'); p.getBuiltinModule('cluster');",
    "(await import('node:process')).default.getBuiltinModule('cluster');",
    "import * as p from 'node:process'; p.default.getBuiltinModule('cluster');",
    "import('node:process').then(p => p.getBuiltinModule('cluster'));",
    "import('node:process').then(({default: {getBuiltinModule: g}}) => g('cluster'));",
    "(await import('node:module')).default.createRequire(import.meta.url)('cluster');",
    "import('node:module').then(({createRequire}) => createRequire(import.meta.url)('cluster'));",
  ])("rejects nested and namespace builtin-loader forms: %s", async (text) => {
    await expect(assertPackagedBuiltinCoverage([source(text)])).rejects.toThrow(
      "NODE_BUILTIN_COVERAGE_FAILED: missing=cluster",
    );
  });

  it.each([
    "const p = require('node:process'); p.getBuiltinModule('node:cluster');",
    "const p = (await import('process')); p.getBuiltinModule('cluster');",
    "import {createRequire} from 'node:module'; const r = createRequire(import.meta.url); const p = r('process'); p.getBuiltinModule('cluster');",
    "const {getBuiltinModule: g} = require('node:process'); (0,g)('cluster');",
  ])("rejects builtin loads through process-module loader aliases: %s", async (text) => {
    await expect(assertPackagedBuiltinCoverage([source(text)])).rejects.toThrow(
      "NODE_BUILTIN_COVERAGE_FAILED: missing=cluster",
    );
  });

  it("tracks named, destructured and member aliases of the builtin loader", async () => {
    const scan = scanBuiltinSource(
      source(`
      import { getBuiltinModule as get } from 'node:process';
      get('dns');
      const { getBuiltinModule: load } = process; load('node:stream');
      const g = process.getBuiltinModule; (0, g)('cluster');
      const { 'getBuiltinModule': take } = globalThis.process; take('util');
      function shadow(get, process) { get('dgram'); process.getBuiltinModule('wasi'); }
    `),
    );
    expect(scan.requiredSpecifiers).toEqual([
      "cluster",
      "dns",
      "node:process",
      "node:stream",
      "util",
    ]);
    expect(scan.ambiguities).toEqual([]);
    await expect(
      assertPackagedBuiltinCoverage([source("const g = process.getBuiltinModule; g('cluster');")]),
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
      (0, require)('dns'); (0, module.require)('node:stream');
      (0, import.meta.require)('dns/promises');
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

  it("tracks builtin calls through namespace, default, named, destructured and require aliases", () => {
    const scan = scanBuiltinSource(
      source(`
      import defaultOS from 'node:os';
      import * as osNamespace from 'os';
      import { platform as namedPlatform } from 'node:os';
      defaultOS.release();
      osNamespace['hostname']();
      namedPlatform();
      const { uptime: uptimeAlias } = require('os'); uptimeAlias();
      const requireAlias = require;
      const requiredOS = requireAlias('node:os'); requiredOS.arch();
      const releaseAlias = requiredOS.release; releaseAlias();
    `),
    );

    expect(
      scan.requiredFunctions.map(({ specifier, memberPath }) => [specifier, memberPath]),
    ).toEqual([
      ["os", ["arch"]],
      ["os", ["hostname"]],
      ["os", ["platform"]],
      ["os", ["release"]],
      ["os", ["release"]],
      ["os", ["uptime"]],
    ]);
    expect(scan.requiredSpecifiers).toContain("os");
    expect(scan.functionAmbiguities).toEqual([]);
  });

  it("preserves calls through computed builtin members as source-located uncertainty", () => {
    const scan = scanBuiltinSource(
      source(`
      import * as os from 'node:os';
      os[process.env.NODE_BUILTIN_FUNCTION]();
      const call = os[process.env.NODE_BUILTIN_FUNCTION]; call();
    `),
    );

    expect(
      scan.functionAmbiguities.map(({ kind, module, line, specifier }) => [
        kind,
        module,
        line,
        specifier,
      ]),
    ).toEqual([
      ["dynamic-builtin-member-call", "release.mjs", 3, "os.<computed>"],
      ["dynamic-builtin-member-call", "release.mjs", 4, "os.<computed>"],
    ]);
    expect(scan.functionCallScope).toBe("static-direct-calls");
  });

  it("does not treat methods on process data fields as Node builtin calls", () => {
    const scan = scanBuiltinSource(
      source(`
      process.env.NODE_TLS_REJECT_UNAUTHORIZED?.trim();
      process.platform.toLowerCase();
      process.stdout.write('done');
    `),
    );

    expect(
      scan.requiredFunctions.map(({ specifier, memberPath }) => [specifier, memberPath]),
    ).toEqual([["process", ["stdout", "write"]]]);
    expect(scan.functionAmbiguities).toEqual([]);
  });

  it("tracks builtin constructors as function-level calls", () => {
    const scan = scanBuiltinSource(
      source(`
      import { URL } from 'node:url';
      new URL('https://signalbox.test');
    `),
    );

    expect(
      scan.requiredFunctions.map(({ specifier, memberPath }) => [specifier, memberPath]),
    ).toEqual([["url", ["URL"]]]);
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
