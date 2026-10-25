import { describe, expect, it } from "@effect/vitest";
import { inventoryReleaseImports } from "./release-inventory-imports.ts";
import type { ScannableModule } from "./release-inventory-imports.ts";

function module(
  index: number,
  key: string,
  loader: number,
  source?: string,
  format?: number,
): ScannableModule {
  return {
    index,
    key,
    name: `/$bunfs/${key}`,
    loader,
    ...(format === undefined ? {} : { format }),
    bytes: source?.length ?? 8,
    ...(source === undefined ? {} : { source }),
  };
}

describe("release module import inventory", () => {
  it("keeps reachable aliases, repeated builtins, dynamic references, and native modules explicit", () => {
    const entry = module(
      0,
      "src/entry.js",
      1,
      `
import * as fs from "node:fs";
import * as legacyFs from "fs";
import "./child.js";
const fsAlias = fs;
fsAlias.readFileSync("a");
legacyFs.existsSync("b");
fs[memberName];
function shadowImportedBuiltin(fs) { fs.notARealNodeApi(); }
function localAlias() { const localFs = fs; localFs.readFileSync("d"); }
function shadowAlias(localFs) { localFs.notARealNodeApi(); }
function localRequire() { const localFs = require("node:fs"); localFs.readFileSync("c"); }
function shadowLocalRequire(localFs) { localFs.notARealNodeApi(); }
require("./addon.node");
const request = require;
request("./addon.node");
await import(moduleName);
require(moduleName);
function shadowRequire(require) { require(moduleName); }
`,
    );
    const child = module(1, "src/child.js", 1, `import * as os from "node:os"; os.platform();`);
    const addon = module(2, "src/addon.node", 10);
    const unreachable = module(3, "src/orphan.js", 1, `import "node:crypto";`);
    const inventory = inventoryReleaseImports([unreachable, addon, child, entry], 0);

    expect([...inventory.reachableIndexes].sort((a, b) => a - b)).toEqual([0, 1, 2]);
    expect(inventory.builtins.map((item) => `${item.specifier}:${item.key}`)).toEqual([
      "fs:src/entry.js",
      "node:fs:src/entry.js",
      "node:os:src/child.js",
    ]);
    expect(
      inventory.builtins
        .find((item) => item.specifier === "node:fs")
        ?.memberUses.map((use) => use.member),
    ).toContain("readFileSync");
    expect(
      inventory.builtins
        .find((item) => item.specifier === "node:fs")
        ?.memberUses.map((use) => use.member),
    ).not.toContain("notARealNodeApi");
    expect(
      inventory.builtins.find((item) => item.specifier === "node:fs")?.dynamicMemberUses,
    ).toHaveLength(1);
    expect(inventory.unresolvedReferences.map((item) => item.kind)).toEqual([
      "dynamic-import",
      "dynamic-require",
    ]);
  });

  it("tracks awaited imports and reports computed, rest, and array destructuring as dynamic", () => {
    const entry = module(
      0,
      "src/entry.js",
      1,
      `
const fs = await import("node:fs");
fs.readFileSync("config.json");
const request = require;
const { [memberName]: selected } = request("fs");
selected();
const { ...rest } = request("fs");
rest.readFileSync("other.json");
const [firstPathEntry] = request("path");
firstPathEntry;
await import("node:path");
`,
    );
    const unreachable = module(1, "src/unreachable.js", 1, "if (");
    const inventory = inventoryReleaseImports([entry, unreachable], 0);
    const nodeFs = inventory.builtins.find((item) => item.specifier === "node:fs");
    const commonJsFs = inventory.builtins.find((item) => item.specifier === "fs");
    const commonJsPath = inventory.builtins.find((item) => item.specifier === "path");
    const nodePath = inventory.builtins.find((item) => item.specifier === "node:path");

    expect(nodeFs?.imports.map((item) => item.kind)).toEqual(["namespace"]);
    expect(nodeFs?.memberUses.map((use) => use.member)).toEqual(["readFileSync"]);
    expect(commonJsFs?.imports.map((item) => item.imported)).toEqual(["*", "*"]);
    expect(commonJsFs?.dynamicMemberUses.length).toBeGreaterThanOrEqual(3);
    expect(commonJsFs?.memberUses.map((use) => use.member)).toContain("readFileSync");
    expect(commonJsPath?.dynamicMemberUses.length).toBeGreaterThan(0);
    expect(nodePath?.imports.map((item) => item.kind)).toEqual(["namespace"]);
    expect(inventory.unresolvedReferences).toEqual([]);
  });

  it("tracks inline awaited namespace members", () => {
    const entry = module(
      0,
      "src/entry.js",
      1,
      `
(await import("node:fs")).readFileSync("config.json");
(await import("node:fs")).promises.readFile("other.json");
(await import("node:fs"))[memberName];
`,
    );
    const inventory = inventoryReleaseImports([entry], 0);
    const nodeFs = inventory.builtins.find((item) => item.specifier === "node:fs");

    expect(nodeFs?.memberUses.map((use) => use.member)).toEqual([
      "readFileSync",
      "promises.readFile",
    ]);
    expect(nodeFs?.dynamicMemberUses).toHaveLength(1);
    expect(inventory.unresolvedReferences).toEqual([]);
  });

  it("keeps promise callbacks and namespace re-exports visible as dynamic members", () => {
    const entry = module(
      0,
      "src/entry.js",
      1,
      `
import("node:fs").then((namespace) => namespace.nope());
export * from "node:fs";
export * as pathNamespace from "node:path";
`,
    );
    const inventory = inventoryReleaseImports([entry], 0);
    const nodeFs = inventory.builtins.find((item) => item.specifier === "node:fs");
    const nodePath = inventory.builtins.find((item) => item.specifier === "node:path");

    expect(nodeFs?.memberUses.map((use) => use.member)).toEqual(["nope"]);
    expect(nodeFs?.dynamicMemberUses).toHaveLength(1);
    expect(nodePath?.dynamicMemberUses).toHaveLength(1);
    expect(inventory.unresolvedReferences).toEqual([]);
  });

  it("resolves meta.require aliases and native dlopen edges without trusting shadowed globals", () => {
    const entry = module(
      0,
      "src/entry.js",
      1,
      `
const require = import.meta.require;
require("./child.js");
const fs = require("node:fs");
fs.readFileSync("config.json");
process.dlopen(module, "./addon.node");
process.dlopen(module, addonPath);
function shadowedProcess(process) {
  process.dlopen(module, "./not-native.node");
}
`,
    );
    const child = module(1, "src/child.js", 1, "export const child = true;");
    const addon = module(2, "src/addon.node", 10);
    const inventory = inventoryReleaseImports([entry, child, addon], 0);

    expect([...inventory.reachableIndexes].sort((a, b) => a - b)).toEqual([0, 1, 2]);
    expect(
      inventory.builtins
        .find((item) => item.specifier === "node:fs")
        ?.memberUses.map((use) => use.member),
    ).toEqual(["readFileSync"]);
    expect(inventory.unresolvedReferences.map((item) => [item.kind, item.specifier])).toEqual([
      ["dynamic-native-load", "<dynamic>"],
    ]);
    expect(inventory.unresolvedBareReferences).toEqual([]);
  });

  it("reads raw format-2 CommonJS wrappers and keeps their require binding local", () => {
    const entry = module(
      0,
      "src/entry.cjs",
      1,
      `(function(exports,require,module,__filename,__dirname){
  const fs = require("node:fs");
  fs.readFileSync("config.json");
  require("./child.cjs");
})`,
      2,
    );
    const child = module(
      1,
      "src/child.cjs",
      1,
      "(function(exports,require,module,__filename,__dirname){module.exports=true})",
      2,
    );
    const inventory = inventoryReleaseImports([entry, child], 0);

    expect([...inventory.reachableIndexes].sort((a, b) => a - b)).toEqual([0, 1]);
    expect(
      inventory.builtins
        .find((item) => item.specifier === "node:fs")
        ?.memberUses.map((use) => use.member),
    ).toEqual(["readFileSync"]);
    expect(inventory.unresolvedReferences).toEqual([]);
  });

  it("surfaces require values that escape direct calls and createRequire wrappers", () => {
    const entry = module(
      0,
      "src/entry.js",
      1,
      `
import { createRequire } from "node:module";
const request = require;
request("./child.js");
pass(require);
pass(request);
require.call(module, "./hidden.js");
createRequire(import.meta.url)("./factory.js");
const localRequire = createRequire(import.meta.url);
localRequire("./local-factory.js");
const __require = typeof require !== "undefined" ? require : missing;
pass(import.meta.require);
`,
    );
    const child = module(1, "src/child.js", 1, "export const child = true;");
    const inventory = inventoryReleaseImports([entry, child], 0);

    expect([...inventory.reachableIndexes].sort((a, b) => a - b)).toEqual([0, 1]);
    expect(inventory.unresolvedReferences.map((item) => item.kind)).toEqual([
      "dynamic-require",
      "dynamic-require",
      "dynamic-require",
      "dynamic-require",
      "dynamic-require",
      "dynamic-require",
      "dynamic-require",
      "dynamic-require",
      "dynamic-require",
    ]);
  });
  it("keeps complete static receiver paths and computed receiver uncertainty", () => {
    const inventory = inventoryReleaseImports(
      [
        module(
          0,
          "entry.js",
          1,
          `
import * as fs from "node:fs";
require("node:fs").promises.newApi();
fs[key].existsSync();
fs.promises.readFile("file");
`,
        ),
      ],
      0,
    );
    const fs = inventory.builtins.find((item) => item.specifier === "node:fs");
    expect(fs?.memberUses.map((use) => use.member)).toEqual([
      "promises.newApi",
      "promises.readFile",
    ]);
    expect(fs?.dynamicMemberUses).toHaveLength(1);
  });

  it("reports every supported createRequire origin and escaping factory result as uncertain", () => {
    const sources = [
      `const {createRequire} = await import("node:module"); createRequire(import.meta.url)("./child.js");`,
      `(await import("node:module")).createRequire(import.meta.url)("./child.js");`,
      `const mod = await import("module"); mod.createRequire(import.meta.url)("./child.js");`,
      `const {createRequire} = (await import("module")); pass(createRequire);`,
      `import("node:module").then((mod) => mod.createRequire(import.meta.url)("./child.js"));`,
      `import("module").then(({createRequire}) => createRequire(import.meta.url)("./child.js"));`,
      `import {createRequire} from "node:module"; var req = createRequire(import.meta.url); req("./child.js");`,
      `import {createRequire} from "node:module"; let req = createRequire(import.meta.url); req("./child.js");`,
      `import * as mod from "node:module"; mod.createRequire(import.meta.url)("./child.js");`,
      `import mod from "module"; const req = mod.createRequire(import.meta.url); pass(req);`,
      `const {createRequire: factory} = require("node:module"); const req = factory(import.meta.url); pass(req);`,
      `const mod = require("module"); mod.createRequire(import.meta.url)("./child.js");`,
      `require("module").createRequire(import.meta.url)("./child.js");`,
      `import {createRequire} from "module"; pass(createRequire);`,
      `import * as mod from "node:module"; pass(mod.createRequire);`,
    ];
    for (const source of sources) {
      const inventory = inventoryReleaseImports(
        [module(0, "entry.js", 1, source), module(1, "child.js", 1, "eval(code)")],
        0,
      );
      expect(inventory.unresolvedReferences.length, source).toBeGreaterThan(0);
      expect(
        inventory.unresolvedReferences.every((item) => item.kind === "dynamic-require"),
        source,
      ).toBe(true);
    }
    const escaped = inventoryReleaseImports(
      [
        module(
          0,
          "entry.js",
          1,
          `import {createRequire} from "module"; const req = createRequire(import.meta.url); pass(req);`,
        ),
      ],
      0,
    );
    expect(escaped.unresolvedReferences).toHaveLength(2);
    const shadowed = inventoryReleaseImports(
      [
        module(
          0,
          "entry.js",
          1,
          `import * as mod from "module"; function local(mod) { mod.createRequire(url)(path); }`,
        ),
      ],
      0,
    );
    expect(shadowed.unresolvedReferences).toEqual([]);
  });

  it("resolves computed meta require and wrapper module.require without leaking shadowed bindings", () => {
    const computed = inventoryReleaseImports(
      [
        module(0, "entry.js", 1, `const req = import.meta["require"]; req("./child.js");`),
        module(1, "child.js", 1, "export {}"),
      ],
      0,
    );
    expect([...computed.reachableIndexes]).toEqual([0, 1]);
    expect(computed.unresolvedReferences).toEqual([]);
    const wrapped = inventoryReleaseImports(
      [
        module(
          0,
          "entry.cjs",
          1,
          `(function(exports,require,module,__filename,__dirname){
module.require("./child.js");
module.require("node:fs").promises.newApi();
const req = module.require; req("./child.js");
function local(module) { module.require("./missing.js"); }
})`,
          2,
        ),
        module(1, "child.js", 1, "export {}"),
      ],
      0,
    );
    expect([...wrapped.reachableIndexes]).toEqual([0, 1]);
    expect(wrapped.unresolvedReferences).toEqual([]);
    expect(
      wrapped.builtins
        .find((item) => item.specifier === "node:fs")
        ?.memberUses.map((use) => use.member),
    ).toEqual(["promises.newApi"]);
  });

  it("marks escaping dynamic imports and non-inline callbacks as dynamic members", () => {
    const sources = [
      `use(import("node:fs"));`,
      `import("node:fs").then(useFs);`,
      `function load() { return import("node:fs"); }`,
      `use(await import("node:fs"));`,
      `function handler(ns) { ns.nope(); } import("node:fs").then(handler);`,
    ];
    for (const source of sources) {
      const inventory = inventoryReleaseImports([module(0, "entry.js", 1, source)], 0);
      expect(inventory.builtins[0]?.dynamicMemberUses, source).toHaveLength(1);
    }
  });

  it("traces aliased process and dlopen bindings with explicit computed native loads", () => {
    const inventory = inventoryReleaseImports(
      [
        module(
          0,
          "entry.js",
          1,
          `
const p = process;
p.dlopen(module, "./addon.node");
const load = p.dlopen;
load(module, addonPath);
const {dlopen: nativeLoad} = process;
nativeLoad(module, "./addon.node");
function local(process) { const p = process; p.dlopen(module, hiddenPath); }
`,
        ),
        module(1, "addon.node", 10),
      ],
      0,
    );
    expect([...inventory.reachableIndexes]).toEqual([0, 1]);
    expect(inventory.unresolvedReferences.map((item) => item.kind)).toEqual([
      "dynamic-native-load",
    ]);
  });
  it("keeps unsupported module import callbacks uncertain while inspecting inline callbacks", () => {
    for (const source of [
      `import("node:module").then(handler);`,
      `function handler(mod) { mod.createRequire(import.meta.url)("./child.js"); } import("module").then(handler);`,
      `use(await import("node:module"));`,
    ]) {
      const inventory = inventoryReleaseImports([module(0, "entry.js", 1, source)], 0);
      expect(
        inventory.unresolvedReferences.map((item) => item.kind),
        source,
      ).toEqual(["dynamic-require"]);
    }
    for (const source of [
      `import("module").then((mod) => mod.isBuiltin("fs"));`,
      `const mod = await import("node:module"); mod.isBuiltin("fs");`,
      `import("fs").then(handler);`,
    ]) {
      expect(
        inventoryReleaseImports([module(0, "entry.js", 1, source)], 0).unresolvedReferences,
        source,
      ).toEqual([]);
    }
  });

  it("traces globalThis process and aliases while excluding a shadowed globalThis", () => {
    const inventory = inventoryReleaseImports(
      [
        module(
          0,
          "entry.js",
          1,
          `
globalThis.process.dlopen(module, "./addon.node");
const p = globalThis["process"];
p.dlopen(module, "./addon.node");
const load = globalThis.process.dlopen;
load(module, unknownPath);
function shadow(globalThis) { globalThis.process.dlopen(module, "./hidden.node"); }
`,
        ),
        module(1, "addon.node", 10),
      ],
      0,
    );
    expect([...inventory.reachableIndexes]).toEqual([0, 1]);
    expect(inventory.unresolvedReferences.map((item) => item.kind)).toEqual([
      "dynamic-native-load",
    ]);
  });
  it("inventories the release qi global.require wrapper and its literal child edge", () => {
    const inventory = inventoryReleaseImports(
      [
        module(
          0,
          "entry.js",
          1,
          `
function qi() { return global.require("inspector").url(); }
qi();
function loadChild() { return global.require("./child.js"); }
loadChild();
`,
        ),
        module(1, "child.js", 1, `require("constants"); require("querystring");`),
      ],
      0,
    );
    expect([...inventory.reachableIndexes]).toEqual([0, 1]);
    expect(inventory.builtins.map((item) => item.canonicalBuiltin)).toEqual([
      "constants",
      "inspector",
      "querystring",
    ]);
    const inspector = inventory.builtins.find((item) => item.canonicalBuiltin === "inspector");
    expect(inspector?.imports.map((item) => item.kind)).toEqual(["require"]);
    expect(inspector?.memberUses.map((item) => item.member)).toEqual(["url"]);
    expect(inventory.unresolvedReferences).toEqual([]);
    expect(inventory.unresolvedBareReferences).toEqual([]);
  });

  it("resolves unshadowed global require members and their existing const aliases", () => {
    for (const source of [
      `global.require("inspector").url(); global.require("./child.js");`,
      `globalThis.require("inspector").url(); globalThis.require("./child.js");`,
      `global["require"]("inspector").url(); global["require"]("./child.js");`,
      `globalThis["require"]("inspector").url(); globalThis["require"]("./child.js");`,
      `const r = global.require; const alias = r; alias("inspector").url(); alias("./child.js");`,
      `const r = globalThis["require"]; r("inspector").url(); r("./child.js");`,
      `function load(require) { globalThis.require("inspector").url(); global.require("./child.js"); }`,
    ]) {
      const inventory = inventoryReleaseImports(
        [module(0, "entry.js", 1, source), module(1, "child.js", 1, "export {};")],
        0,
      );
      expect([...inventory.reachableIndexes], source).toEqual([0, 1]);
      expect(
        inventory.builtins.map((item) => item.canonicalBuiltin),
        source,
      ).toEqual(["inspector"]);
      expect(
        inventory.builtins[0]?.memberUses.map((item) => item.member),
        source,
      ).toEqual(["url"]);
      expect(inventory.unresolvedReferences, source).toEqual([]);
    }
  });

  it("does not grant require origins to shadowed global objects or guessed helper names", () => {
    for (const source of [
      `function local(global) { global.require("inspector"); global.require("./hidden.js"); }`,
      `function local(globalThis) { globalThis["require"]("inspector"); globalThis.require("./hidden.js"); }`,
      `const global = localObject; global.require("inspector"); const r = global.require; r("./hidden.js");`,
      `function local() { const globalThis = localObject; const r = globalThis["require"]; r("inspector"); r("./hidden.js"); }`,
      `function local(global) { const r = global.require; function nested(r) { r("inspector"); } r("./hidden.js"); }`,
      `const r = global.require; function local(r) { r("inspector"); r("./hidden.js"); }`,
      `Ue("inspector"); bridge.require("./hidden.js");`,
    ]) {
      const inventory = inventoryReleaseImports([module(0, "entry.js", 1, source)], 0);
      expect(inventory.builtins, source).toEqual([]);
      expect(inventory.unresolvedReferences, source).toEqual([]);
      expect(inventory.unresolvedBareReferences, source).toEqual([]);
    }
  });

  it("reports escaping and computed global require loads as uncertainty", () => {
    const inventory = inventoryReleaseImports(
      [
        module(
          0,
          "entry.js",
          1,
          `
pass(global.require);
globalThis["require"](moduleName);
`,
        ),
      ],
      0,
    );
    expect(inventory.unresolvedReferences.map((item) => item.kind)).toEqual([
      "dynamic-require",
      "dynamic-require",
    ]);
  });
});
