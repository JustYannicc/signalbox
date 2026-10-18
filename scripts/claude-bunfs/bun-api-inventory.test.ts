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
          "[value = Bun.arrayDefault()] = other;",
          "({ x: value = Bun.renamedDefault() } = other);",
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
        { path: "arrayDefault", accesses: ["call"] },
        { path: "assignmentDefault", accesses: ["call"] },
        { path: "assignmentPatternKey", accesses: ["call"] },
        { path: "assignmentTarget", accesses: ["call"] },
        { path: "bindingDefault", accesses: ["call"] },
        { path: "bindingKey", accesses: ["call"] },
        { path: "computedMethodName", accesses: ["call"] },
        { path: "renamedDefault", accesses: ["call"] },
      ],
    );
    assert.deepStrictEqual(inventory.dynamicAccesses, []);
  });

  it("keeps outer Bun aliases when a loop header shadows them", () => {
    const inventory = inventoryBunApis([
      {
        name: "loop-shadow.js",
        source: "let api = Bun.hash; for (let api = 0; api < 1; api++) {} api();",
      },
    ]);

    assert.deepStrictEqual(
      inventory.members.map(({ path, occurrences }) => ({
        path,
        accesses: occurrences.map(({ access }) => access),
      })),
      [{ path: "hash", accesses: ["read", "call"] }],
    );
    assert.deepStrictEqual(inventory.dynamicAccesses, []);
  });

  it("does not invent Bun aliases from loop-local declarations", () => {
    const inventory = inventoryBunApis([
      {
        name: "loop-local.js",
        source: "let api = {}; for (let api = Bun; false;) {} api.newAPI();",
      },
    ]);

    assert.deepStrictEqual(inventory.members, []);
    assert.deepStrictEqual(inventory.dynamicAccesses, []);
  });

  it("reports unresolved destructuring from uncertain Bun values", () => {
    for (const source of [
      "const {[key]: api} = flag ? Bun : other; api();",
      "const {...api} = flag ? Bun : other; api.newAPI();",
      "const [api] = flag ? Bun : other; api();",
      "let api; ({[key]: api} = flag ? Bun : other); api();",
      "let api; ({...api} = flag ? Bun : other); api.newAPI();",
      "let api; [api] = flag ? Bun : other; api();",
    ]) {
      const inventory = inventoryBunApis([{ name: "uncertain-pattern.js", source }]);

      assert.deepStrictEqual(inventory.members, [], source);
      assert.deepStrictEqual(
        inventory.dynamicAccesses.map(({ basePath, access }) => ({ basePath, access })),
        [{ basePath: "", access: "read" }],
        source,
      );
    }
  });

  it("preserves possible Bun member aliases supplied by pattern defaults", () => {
    for (const source of [
      "let api; [api = Bun.fs] = []; api.readFile();",
      "let api; ({value: api = Bun.fs} = other); api.readFile();",
      "let api; ({api = Bun.fs} = other); api.readFile();",
      "const [api = Bun.fs] = []; api.readFile();",
      "const {value: api = Bun.fs} = other; api.readFile();",
    ]) {
      const inventory = inventoryBunApis([{ name: "default-alias.js", source }]);

      assert.deepStrictEqual(
        inventory.members.map(({ path }) => path),
        ["fs"],
        source,
      );
      assert.ok(
        inventory.dynamicAccesses.some(
          ({ basePath, access }) => basePath === "" && access === "call",
        ),
        source,
      );
    }
  });

  it("clears stale aliases overwritten by non-Bun pattern defaults", () => {
    for (const pattern of [
      "[api = 0] = [1]",
      "({value: api = 0} = other)",
      "({api = 0} = other)",
      "({...api} = other)",
    ]) {
      const inventory = inventoryBunApis([
        { name: "overwritten-default.js", source: `let api = Bun.hash; ${pattern}; api();` },
      ]);

      assert.deepStrictEqual(
        inventory.members.map(({ path, occurrences }) => ({
          path,
          accesses: occurrences.map(({ access }) => access),
        })),
        [{ path: "hash", accesses: ["read"] }],
        pattern,
      );
      assert.deepStrictEqual(inventory.dynamicAccesses, [], pattern);
    }
  });

  it("merges outer alias writes with the path that skips a default", () => {
    for (const pattern of [
      "let x; [x = (api = other)] = values; api.newAPI();",
      "let x; ({value: x = (api = other)} = values); api.newAPI();",
      "let x; ({x = (api = other)} = values); api.newAPI();",
      "const [x = (api = other)] = values; api.newAPI();",
      "const {value: x = (api = other)} = values; api.newAPI();",
      "function run(x = (api = other)) { api.newAPI(); }",
    ]) {
      const inventory = inventoryBunApis([
        { name: "conditional-default.js", source: `let api = Bun; ${pattern}` },
      ]);

      assert.deepStrictEqual(inventory.members, [], pattern);
      assert.ok(
        inventory.dynamicAccesses.some(
          ({ basePath, access }) => basePath === "" && access === "call",
        ),
        pattern,
      );
    }
  });

  it("evaluates destructuring defaults after the right-hand side", () => {
    for (const pattern of [
      "[x = (api = Bun.fs)]",
      "{value: x = (api = Bun.fs)}",
      "{x = (api = Bun.fs)}",
    ]) {
      const inventory = inventoryBunApis([
        {
          name: "default-order.js",
          source: `let api; let x; (${pattern} = (api = other, values)); api.newAPI();`,
        },
      ]);

      assert.deepStrictEqual(
        inventory.members.map(({ path }) => path),
        ["fs"],
        pattern,
      );
      assert.ok(
        inventory.dynamicAccesses.some(
          ({ basePath, access }) => basePath === "" && access === "call",
        ),
        pattern,
      );
    }
  });

  it("evaluates ordinary assignment targets before the right-hand side", () => {
    const inventory = inventoryBunApis([
      {
        name: "ordinary-order.js",
        source: "let api; target[(api = other, key)] = (api = Bun.fs); api.readFile();",
      },
    ]);

    assert.deepStrictEqual(
      inventory.members.map(({ path, occurrences }) => ({
        path,
        accesses: occurrences.map(({ access }) => access),
      })),
      [
        { path: "fs", accesses: ["read"] },
        { path: "fs.readFile", accesses: ["call"] },
      ],
    );
    assert.deepStrictEqual(inventory.dynamicAccesses, []);
  });

  it("evaluates for-in/of sources before optional head defaults", () => {
    for (const source of [
      "let api; let x; for ([x = (api = Bun.fs)] of (api = other, values)) api.newAPI();",
      "let api; for (const [x = (api = Bun.fs)] of (api = other, values)) api.newAPI();",
      "let api; let x; for ([x = (api = Bun.fs)] in (api = other, values)) api.newAPI();",
      "let api; for (const [x = (api = Bun.fs)] in (api = other, values)) api.newAPI();",
    ]) {
      const inventory = inventoryBunApis([{ name: "iteration-default-order.js", source }]);

      assert.deepStrictEqual(
        inventory.members.map(({ path }) => path),
        ["fs"],
        source,
      );
      assert.ok(
        inventory.dynamicAccesses.some(
          ({ basePath, access }) => basePath === "" && access === "call",
        ),
        source,
      );
    }
  });

  it("preserves possible Bun aliases from iteration head defaults", () => {
    for (const source of [
      "for (const [api = Bun.fs] of values) api.newAPI();",
      "let api; for ([api = Bun.fs] of values) api.newAPI();",
      "for (const {value: api = Bun.fs} of values) api.newAPI();",
      "let api; for ({api = Bun.fs} of values) api.newAPI();",
    ]) {
      const inventory = inventoryBunApis([{ name: "iteration-default-alias.js", source }]);

      assert.deepStrictEqual(
        inventory.members.map(({ path }) => path),
        ["fs"],
        source,
      );
      assert.ok(
        inventory.dynamicAccesses.some(
          ({ basePath, access }) => basePath === "" && access === "call",
        ),
        source,
      );
    }
  });

  it("binds earlier pattern elements before evaluating later defaults", () => {
    for (const source of [
      "let api, x; for ([api = Bun.fs, x = api.newAPI()] of values) {}",
      "for (let [api = Bun.fs, x = api.newAPI()] of values) {}",
      "let api, x; [api = Bun.fs, x = api.newAPI()] = values;",
      "let [api = Bun.fs, x = api.newAPI()] = values;",
      "let {api = Bun.fs, x = api.newAPI()} = values;",
      "let api, x; ({api = Bun.fs, x = api.newAPI()} = values);",
      "function run([api = Bun.fs, x = api.newAPI()]) {}",
    ]) {
      const inventory = inventoryBunApis([{ name: "sequential-defaults.js", source }]);

      assert.deepStrictEqual(
        inventory.members.map(({ path }) => path),
        ["fs"],
        source,
      );
      assert.ok(
        inventory.dynamicAccesses.some(
          ({ basePath, access }) => basePath === "" && access === "call",
        ),
        source,
      );
    }
  });

  it("keeps later default writes after earlier pattern bindings", () => {
    for (const source of [
      "let api, x; for ([api, x = (api = Bun.fs)] of values) api.newAPI();",
      "for (let [api, x = (api = Bun.fs)] of values) api.newAPI();",
      "let api, x; [api, x = (api = Bun.fs)] = values; api.newAPI();",
      "let [api, x = (api = Bun.fs)] = values; api.newAPI();",
      "let {api, x = (api = Bun.fs)} = values; api.newAPI();",
      "let api, x; ({api, x = (api = Bun.fs)} = values); api.newAPI();",
      "function run([api, x = (api = Bun.fs)]) { api.newAPI(); }",
    ]) {
      const inventory = inventoryBunApis([{ name: "sequential-default-writes.js", source }]);

      assert.deepStrictEqual(
        inventory.members.map(({ path }) => path),
        ["fs"],
        source,
      );
      assert.ok(
        inventory.dynamicAccesses.some(
          ({ basePath, access }) => basePath === "" && access === "call",
        ),
        source,
      );
    }
  });

  it("records Bun member objects read while assigning properties", () => {
    for (const source of [
      "for (Bun.fs.x of values) {}",
      "Bun.fs.x = value;",
      "({value: Bun.fs.x} = values);",
    ]) {
      const inventory = inventoryBunApis([{ name: "write-base.js", source }]);

      assert.deepStrictEqual(
        inventory.members.map(({ path, occurrences }) => ({
          path,
          accesses: occurrences.map(({ access }) => access),
        })),
        [{ path: "fs", accesses: ["read"] }],
        source,
      );
      assert.deepStrictEqual(inventory.dynamicAccesses, [], source);
    }
  });

  it("clears var aliases when iteration assigns a new value", () => {
    const inventory = inventoryBunApis([
      {
        name: "iteration-var.js",
        source: "var api = Bun.fs; for (var api of values) api.readFile();",
      },
    ]);

    assert.deepStrictEqual(
      inventory.members.map(({ path }) => path),
      ["fs"],
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
