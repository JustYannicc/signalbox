import { assert, describe, it } from "@effect/vitest";

import { inventoryBunApis } from "./bun-api-inventory.ts";

describe("inventoryBunApis", () => {
  it("finds guarded global and Bun member accesses without counting chain prefixes", () => {
    const inventory = inventoryBunApis([
      {
        name: "bundle.js",
        source: [
          'if (typeof Bun !== "undefined") {',
          '  Bun.hash("plain");',
          '  Bun.hash.crc32("nested");',
          "  const peerPid = globalThis.Bun?.ant?.getPeerPid;",
          "  new Bun.Transpiler({});",
          '  Bun["version"];',
          '  Bun[`which`]?.("node");',
          "}",
          "",
        ].join("\n"),
      },
    ]);

    assert.deepStrictEqual(
      inventory.members.map(({ path, occurrences }) => ({
        path,
        accesses: occurrences.map(({ access }) => access),
      })),
      [
        { path: "ant.getPeerPid", accesses: ["read"] },
        { path: "hash", accesses: ["call"] },
        { path: "hash.crc32", accesses: ["call"] },
        { path: "Transpiler", accesses: ["construct"] },
        { path: "version", accesses: ["read"] },
        { path: "which", accesses: ["call"] },
      ],
    );
    assert.deepStrictEqual(inventory.dynamicAccesses, []);
    assert.deepStrictEqual(inventory.members[0]?.occurrences[0], {
      module: "bundle.js",
      offset: 101,
      line: 4,
      column: 19,
      access: "read",
    });
  });

  it("follows namespace, named, destructured, and assigned aliases", () => {
    const inventory = inventoryBunApis([
      {
        name: "aliases.js",
        source: [
          'import * as bun from "bun";',
          'import { spawn as spawnBun } from "bun";',
          'import Bun from "bun";',
          'bun.semver.satisfies("1.0");',
          'spawnBun("echo");',
          'Bun.hash("default import");',
          "const { ant: { getPeerPid: peerPid } } = bun;",
          "peerPid();",
          "let hash;",
          "hash = Bun.hash;",
          'hash("assigned alias");',
          "const { crc32 } = Bun.hash;",
          'crc32("destructured alias");',
          "",
        ].join("\n"),
      },
    ]);

    assert.deepStrictEqual(
      inventory.members.map(({ path, occurrences }) => ({
        path,
        accesses: occurrences.map(({ access }) => access),
      })),
      [
        { path: "ant.getPeerPid", accesses: ["read", "call"] },
        { path: "hash", accesses: ["call", "read", "call", "read"] },
        { path: "hash.crc32", accesses: ["read", "call"] },
        { path: "semver.satisfies", accesses: ["call"] },
        { path: "spawn", accesses: ["read", "call"] },
      ],
    );
    assert.deepStrictEqual(inventory.dynamicAccesses, []);
  });

  it("keeps function alias reassignments inside the function traversal", () => {
    const inventory = inventoryBunApis([
      {
        name: "functions.js",
        source: [
          "let api = Bun.hash;",
          "function replaceApi() {",
          "  api = Bun.version;",
          "  api();",
          "}",
          "api();",
        ].join("\n"),
      },
    ]);

    assert.deepStrictEqual(
      inventory.members.map(({ path, occurrences }) => ({
        path,
        accesses: occurrences.map(({ access }) => access),
      })),
      [
        { path: "hash", accesses: ["read", "call"] },
        { path: "version", accesses: ["read", "call"] },
      ],
    );
  });

  it("merges nested branch reassignments conservatively", () => {
    const inventory = inventoryBunApis([
      {
        name: "branch.js",
        source: [
          "let api = Bun.hash;",
          "if (condition) {",
          "  { api = Bun.version; }",
          "}",
          "api();",
        ].join("\n"),
      },
    ]);

    assert.deepStrictEqual(
      inventory.members.map(({ path, occurrences }) => ({
        path,
        accesses: occurrences.map(({ access }) => access),
      })),
      [
        { path: "hash", accesses: ["read"] },
        { path: "version", accesses: ["read"] },
      ],
    );
    assert.deepStrictEqual(
      inventory.dynamicAccesses.map(({ basePath, access }) => ({ basePath, access })),
      [{ basePath: "", access: "call" }],
    );
  });

  it("retains only aliases assigned to the same Bun member on every branch", () => {
    const inventory = inventoryBunApis([
      {
        name: "merge.js",
        source: [
          "let same;",
          "if (condition) { { same = Bun.hash; } }",
          "else { { same = Bun.hash; } }",
          "same();",
          "let different;",
          "if (condition) different = Bun.hash;",
          "else different = Bun.version;",
          "different();",
        ].join("\n"),
      },
    ]);

    assert.deepStrictEqual(
      inventory.members.map(({ path, occurrences }) => ({
        path,
        accesses: occurrences.map(({ access }) => access),
      })),
      [
        { path: "hash", accesses: ["read", "read", "call", "read"] },
        { path: "version", accesses: ["read"] },
      ],
    );
    assert.deepStrictEqual(
      inventory.dynamicAccesses.map(({ basePath, access }) => ({ basePath, access })),
      [{ basePath: "", access: "call" }],
    );
  });

  it("does not infer an alias after conditional or short-circuit reassignment", () => {
    const inventory = inventoryBunApis([
      {
        name: "conditional-merge.js",
        source: [
          "let conditional = Bun.hash;",
          "condition ? (conditional = Bun.version) : undefined;",
          "conditional();",
          "let shortCircuit = Bun.hash;",
          "condition && (shortCircuit = Bun.version);",
          "shortCircuit();",
        ].join("\n"),
      },
    ]);

    assert.deepStrictEqual(
      inventory.members.map(({ path, occurrences }) => ({
        path,
        accesses: occurrences.map(({ access }) => access),
      })),
      [
        { path: "hash", accesses: ["read", "read"] },
        { path: "version", accesses: ["read", "read"] },
      ],
    );
    assert.deepStrictEqual(
      inventory.dynamicAccesses.map(({ basePath, access }) => ({ basePath, access })),
      [
        { basePath: "", access: "call" },
        { basePath: "", access: "call" },
      ],
    );
  });

  it("reports root aliases as dynamic when some control-flow path may not be Bun", () => {
    const inventory = inventoryBunApis([
      {
        name: "uncertain.js",
        source: [
          "let api = Bun;",
          "if (condition) api = other;",
          "api.newAPI();",
          "const selected = condition ? Bun : other;",
          "selected.newAPI();",
          "selected[key]();",
          "let stable;",
          "if (condition) stable = Bun;",
          "else stable = globalThis.Bun;",
          "stable.newAPI();",
        ].join("\n"),
      },
    ]);

    assert.deepStrictEqual(
      inventory.members.map(({ path, occurrences }) => ({
        path,
        accesses: occurrences.map(({ access }) => access),
      })),
      [{ path: "newAPI", accesses: ["call"] }],
    );
    assert.deepStrictEqual(
      inventory.dynamicAccesses.map(({ module, basePath, access, line }) => ({
        module,
        basePath,
        access,
        line,
      })),
      [
        { module: "uncertain.js", basePath: "", access: "call", line: 3 },
        { module: "uncertain.js", basePath: "", access: "call", line: 5 },
        { module: "uncertain.js", basePath: "", access: "call", line: 6 },
      ],
    );
  });

  it("reports computed accesses separately while keeping literal brackets static", () => {
    const inventory = inventoryBunApis([
      {
        name: "dynamic.js",
        source: [
          "Bun[name]();",
          "Bun.ant[key]?.();",
          'Bun["hash"]();',
          "Bun.hash.crc32(data);",
          "",
        ].join("\n"),
      },
    ]);

    assert.deepStrictEqual(
      inventory.members.map(({ path, occurrences }) => ({
        path,
        accesses: occurrences.map(({ access }) => access),
      })),
      [
        { path: "hash", accesses: ["call"] },
        { path: "hash.crc32", accesses: ["call"] },
      ],
    );
    assert.deepStrictEqual(
      inventory.dynamicAccesses.map(({ basePath, access, line }) => ({ basePath, access, line })),
      [
        { basePath: "", access: "call", line: 1 },
        { basePath: "ant", access: "call", line: 2 },
      ],
    );
  });

  it("ignores comments, template text, and shadowed Bun names", () => {
    const modules = [
      {
        name: "shadowed.js",
        source: [
          "// Bun.hash() is only a comment.",
          'const example = "Bun.hash()";',
          "`Bun.hash() is template text`; ",
          "`template interpolation: ${Bun.version}`;",
          "function parameter(Bun) { Bun.hash(); }",
          "function local() { Bun.hash(); const Bun = {}; }",
          "function globalThisShadow(globalThis) { globalThis.Bun.hash(); }",
          "function aliasShadow(bun) { bun.hash(); }",
          "",
        ].join("\n"),
      },
      {
        name: "whole-module-shadow.js",
        source: "Bun.hash(); const Bun = {}; Bun.hash();",
      },
    ];
    const inventory = inventoryBunApis(modules);

    assert.deepStrictEqual(
      inventory.members.map(({ path, occurrences }) => ({
        path,
        modules: occurrences.map(({ module }) => module),
      })),
      [{ path: "version", modules: ["shadowed.js"] }],
    );
    assert.deepStrictEqual(inventory.dynamicAccesses, []);
  });

  it("supports require aliases and sorts modules and locations", () => {
    const inventory = inventoryBunApis([
      { name: "z.js", source: "const bun = require('bun'); bun.hash();" },
      { name: "a.js", source: "Bun.hash; Bun.hash;" },
    ]);

    const hash = inventory.members.find((member) => member.path === "hash");
    assert.ok(hash);
    assert.deepStrictEqual(
      hash.occurrences.map(({ module, offset, access, line, column }) => ({
        module,
        offset,
        access,
        line,
        column,
      })),
      [
        { module: "a.js", offset: 0, access: "read", line: 1, column: 1 },
        { module: "a.js", offset: 10, access: "read", line: 1, column: 11 },
        { module: "z.js", offset: 28, access: "call", line: 1, column: 29 },
      ],
    );
  });

  it("classifies calls through parenthesized Bun member expressions", () => {
    const inventory = inventoryBunApis([{ name: "parenthesized.js", source: "(Bun.newAPI)();" }]);

    assert.deepStrictEqual(
      inventory.members.map(({ path, occurrences }) => ({
        path,
        accesses: occurrences.map(({ access }) => access),
      })),
      [{ path: "newAPI", accesses: ["call"] }],
    );
    assert.deepStrictEqual(inventory.dynamicAccesses, []);
  });

  it("visits binding defaults, computed names, and assignment targets", () => {
    const inventory = inventoryBunApis([
      {
        name: "evaluated-patterns.js",
        source: [
          "const { value = Bun.bindingDefault() } = other;",
          "const { [Bun.bindingKey()]: computed } = other;",
          "out[Bun.assignmentTarget()] = value;",
          "({ [Bun.assignmentPatternKey()]: out.value, fallback = Bun.assignmentDefault() } = other);",
          "const object = { [Bun.computedMethodName()]() {} };",
        ].join("\n"),
      },
    ]);

    assert.deepStrictEqual(
      inventory.members.map(({ path, occurrences }) => ({
        path,
        accesses: occurrences.map(({ access }) => access),
      })),
      [
        { path: "assignmentDefault", accesses: ["call"] },
        { path: "assignmentPatternKey", accesses: ["call"] },
        { path: "assignmentTarget", accesses: ["call"] },
        { path: "bindingDefault", accesses: ["call"] },
        { path: "bindingKey", accesses: ["call"] },
        { path: "computedMethodName", accesses: ["call"] },
      ],
    );
    assert.deepStrictEqual(inventory.dynamicAccesses, []);
  });

  it("keeps short-circuit Bun aliases as uncertain accesses", () => {
    const inventory = inventoryBunApis([
      {
        name: "short-circuit-aliases.js",
        source: [
          "const logicalOr = Bun || fallback;",
          "logicalOr.newAPI();",
          "const nullish = Bun ?? fallback;",
          "nullish.newAPI();",
        ].join("\n"),
      },
    ]);

    assert.deepStrictEqual(inventory.members, []);
    assert.deepStrictEqual(
      inventory.dynamicAccesses.map(({ basePath, access }) => ({ basePath, access })),
      [
        { basePath: "", access: "call" },
        { basePath: "", access: "call" },
      ],
    );
  });

  it("preserves the zero-iteration path when aliases change inside loops", () => {
    const inventory = inventoryBunApis([
      {
        name: "loop-aliases.js",
        source: [
          "let whileApi = Bun.hash;",
          "while (condition) whileApi = fallback;",
          "whileApi();",
          "let forApi = Bun.version;",
          "for (; condition;) forApi = fallback;",
          "forApi();",
        ].join("\n"),
      },
    ]);

    assert.deepStrictEqual(
      inventory.members.map(({ path, occurrences }) => ({
        path,
        accesses: occurrences.map(({ access }) => access),
      })),
      [
        { path: "hash", accesses: ["read"] },
        { path: "version", accesses: ["read"] },
      ],
    );
    assert.deepStrictEqual(
      inventory.dynamicAccesses.map(({ basePath, access }) => ({ basePath, access })),
      [
        { basePath: "", access: "call" },
        { basePath: "", access: "call" },
      ],
    );
  });

  it("resolves Bun destructured from globalThis and keeps uncertain destructures dynamic", () => {
    const inventory = inventoryBunApis([
      {
        name: "destructured-roots.js",
        source: [
          "const { Bun: globalBun } = globalThis;",
          "globalBun.newAPI();",
          "const { newAPI: possibleApi } = flag ? Bun : fallback;",
          "possibleApi();",
        ].join("\n"),
      },
    ]);

    assert.deepStrictEqual(
      inventory.members.map(({ path, occurrences }) => ({
        path,
        accesses: occurrences.map(({ access }) => access),
      })),
      [{ path: "newAPI", accesses: ["call"] }],
    );
    assert.deepStrictEqual(
      inventory.dynamicAccesses.map(({ basePath, access }) => ({ basePath, access })),
      [{ basePath: "", access: "call" }],
    );
  });

  it("does not treat a method or getter named Bun as a lexical binding", () => {
    const inventory = inventoryBunApis([
      {
        name: "method-bun.js",
        source: [
          "const methods = {",
          "  Bun() { return Bun.hash(); },",
          "  get Bun() { return Bun.version; },",
          "  set Bun(value) { Bun.configure(value); },",
          "};",
        ].join("\n"),
      },
    ]);

    assert.deepStrictEqual(
      inventory.members.map(({ path, occurrences }) => ({
        path,
        accesses: occurrences.map(({ access }) => access),
      })),
      [
        { path: "configure", accesses: ["call"] },
        { path: "hash", accesses: ["call"] },
        { path: "version", accesses: ["read"] },
      ],
    );
    assert.deepStrictEqual(inventory.dynamicAccesses, []);
  });

  it("treats a named class expression name as local to its body", () => {
    const inventory = inventoryBunApis([
      {
        name: "class-expression.js",
        source: [
          "const Local = class Bun {",
          "  method() { return Bun.hash(); }",
          "  get value() { return Bun.version; }",
          "};",
          "Bun.outside();",
        ].join("\n"),
      },
    ]);

    assert.deepStrictEqual(
      inventory.members.map(({ path, occurrences }) => ({
        path,
        accesses: occurrences.map(({ access }) => access),
      })),
      [{ path: "outside", accesses: ["call"] }],
    );
    assert.deepStrictEqual(inventory.dynamicAccesses, []);
  });

  it("follows aliases from an awaited dynamic Bun import", () => {
    const inventory = inventoryBunApis([
      {
        name: "dynamic-import.js",
        source: "const bun = await import('bun'); bun.newAPI();",
      },
    ]);

    assert.deepStrictEqual(
      inventory.members.map(({ path, occurrences }) => ({
        path,
        accesses: occurrences.map(({ access }) => access),
      })),
      [{ path: "newAPI", accesses: ["call"] }],
    );
    assert.deepStrictEqual(inventory.dynamicAccesses, []);
  });

  it("visits defaults in for-of binding declarations without initializers", () => {
    const inventory = inventoryBunApis([
      {
        name: "for-of-default.js",
        source: "for (const { x = Bun.newAPI() } of values) {}",
      },
    ]);

    assert.deepStrictEqual(
      inventory.members.map(({ path, occurrences }) => ({
        path,
        accesses: occurrences.map(({ access }) => access),
      })),
      [{ path: "newAPI", accesses: ["call"] }],
    );
    assert.deepStrictEqual(inventory.dynamicAccesses, []);
  });

  it("records only escaping Bun roots when inference is unsupported", () => {
    const inventory = inventoryBunApis([
      {
        name: "escaping-roots.js",
        source: [
          "function withDefault(api = Bun) { api.newAPI(); }",
          "consume(Bun);",
          "const copied = { ...Bun };",
          "let maybe;",
          "maybe ??= Bun;",
          "const alias = Bun; alias.hash();",
          "let reassigned; reassigned = Bun; reassigned.version;",
          'if (typeof Bun !== "undefined") {}',
        ].join("\n"),
      },
    ]);

    assert.deepStrictEqual(
      inventory.members.map(({ path, occurrences }) => ({
        path,
        accesses: occurrences.map(({ access }) => access),
      })),
      [
        { path: "hash", accesses: ["call"] },
        { path: "version", accesses: ["read"] },
      ],
    );
    assert.deepStrictEqual(
      inventory.dynamicAccesses.map(({ basePath, access }) => ({ basePath, access })),
      [
        { basePath: "", access: "read" },
        { basePath: "", access: "read" },
        { basePath: "", access: "read" },
        { basePath: "", access: "read" },
      ],
    );
  });

  it("rejects parser recovery with the module and source position", () => {
    assert.throws(
      () => inventoryBunApis([{ name: "broken.js", source: "Bun.hash(;" }]),
      /broken\.js:\d+:\d+:/,
    );
  });
});
