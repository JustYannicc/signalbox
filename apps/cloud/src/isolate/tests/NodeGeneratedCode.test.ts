// @effect-diagnostics nodeBuiltinImport:off - uses an isolated in-memory SQLite database, never live userdata.
import { describe, expect, it } from "@effect/vitest";
import type { FacetStorage } from "../../kernel/FacetSqliteStorage.ts";
import {
  createNodeGeneratedCode,
  NodeGeneratedCodeIntegrityError,
  NodeGeneratedCodeInputError,
  NodeGeneratedCodeRuntimeUnavailableError,
  NodeGeneratedCodeUnavailableError,
  nodeGeneratedCodeGraphDigest,
  nodeGeneratedFunctionSourceKey,
  type NodeGeneratedCodeInvokeInput,
  type NodeGeneratedFunctionKind,
  type NodeGeneratedFunctionModuleRuntime,
} from "../NodeGeneratedCode.ts";

import { nodeGeneratedCodeSqliteFixture as sqliteFixture } from "./generatedCodeFixture.ts";

const request = (
  overrides: Partial<NodeGeneratedCodeInvokeInput> = {},
): NodeGeneratedCodeInvokeInput => ({
  id: "caller-label",
  mainModule: "main.js",
  modules: { "main.js": "module.exports = 1;", "lib/value.js": "module.exports = 2;" },
  input: { prompt: "run" },
  ...overrides,
});

const functionKinds: readonly NodeGeneratedFunctionKind[] = [
  "function",
  "async",
  "generator",
  "asyncGenerator",
];

const testFunctionRuntime: NodeGeneratedFunctionModuleRuntime = {
  runtimeFunctionModule(kind, params, body) {
    return `module.exports = function () { return ${JSON.stringify([kind, params, body])}; };`;
  },
};

const withFunctionRuntime = (storage: FacetStorage, scopeId: string) =>
  createNodeGeneratedCode({ storage, scopeId, functionRuntime: testFunctionRuntime });

describe("Node generated code", () => {
  it("content-addresses exact module graph bytes independent of record insertion order", async () => {
    const first = await nodeGeneratedCodeGraphDigest(request());
    const reordered = await nodeGeneratedCodeGraphDigest(
      request({
        modules: { "lib/value.js": "module.exports = 2;", "main.js": "module.exports = 1;" },
      }),
    );
    const changedSource = await nodeGeneratedCodeGraphDigest(
      request({
        modules: { "main.js": "module.exports = 3;", "lib/value.js": "module.exports = 2;" },
      }),
    );
    const changedName = await nodeGeneratedCodeGraphDigest(
      request({
        modules: { "main.js": "module.exports = 1;", "lib/renamed.js": "module.exports = 2;" },
      }),
    );
    const changedMain = await nodeGeneratedCodeGraphDigest(request({ mainModule: "lib/value.js" }));
    const changedLabel = await nodeGeneratedCodeGraphDigest(request({ id: "a-different-label" }));

    expect(reordered).toBe(first);
    expect(changedLabel).toBe(first);
    expect(changedSource).not.toBe(first);
    expect(changedName).not.toBe(first);
    expect(changedMain).not.toBe(first);
  });

  it("preserves exact digest bytes without calling replaced conversion helpers", async () => {
    const input = {
      mainModule: "main.js",
      modules: { "main.js": "module.exports = 'Grüezi 😀';" },
    };
    const replacements = [
      [Array, "from"],
      [Array.prototype, "join"],
      [Number.prototype, "toString"],
      [String.prototype, "padStart"],
      [Object.getPrototypeOf(Uint8Array.prototype), Symbol.iterator],
    ] as const;
    const define = Object.defineProperty;
    const descriptors = replacements.map(([target, key]) =>
      Object.getOwnPropertyDescriptor(target, key)!,
    );
    let calls = 0;
    let digest: string;
    try {
      for (let index = 0; index < replacements.length; index++) {
        const [target, key] = replacements[index]!;
        define(target, key, {
          configurable: true,
          writable: true,
          value() {
            calls++;
            throw new Error("A replaced helper ran while hashing generated code");
          },
        });
      }
      digest = await nodeGeneratedCodeGraphDigest(input);
    } finally {
      for (let index = 0; index < replacements.length; index++) {
        const [target, key] = replacements[index]!;
        define(target, key, descriptors[index]!);
      }
    }
    expect(calls).toBe(0);
    // Independent SHA-256 of the length-framed, JSON-quoted UTF-8 fields.
    expect(digest).toBe("2eebb7b2eeb3ca962fff113e598ba0a23f70222b034f5c0bec0d52f8939bd71c");
  });

  it("posts the frozen envelope and returns the binding Response unchanged", async () => {
    const fixture = sqliteFixture();
    const response = new Response('{"value":1}', {
      status: 207,
      headers: { "x-generated-result": "kept" },
    });
    let captured: Request | undefined;
    const generated = createNodeGeneratedCode({
      scopeId: "facet-a",
      storage: fixture.storage,
      fetcher: {
        async fetch(input) {
          captured = input;
          return response;
        },
      },
    });

    try {
      const result = await generated.invoke(request());
      expect(result).toBe(response);
      expect(result.status).toBe(207);
      expect(result.headers.get("x-generated-result")).toBe("kept");
      expect(await result.text()).toBe('{"value":1}');
      expect(captured?.method).toBe("POST");
      expect(new URL(captured?.url ?? "https://invalid").pathname).toBe("/invoke");
      expect(captured?.headers.get("content-type")).toBe("application/json");
      expect(await captured?.text()).toBe(
        '{"id":"caller-label","mainModule":"main.js","modules":{"lib/value.js":"module.exports = 2;",' +
          '"main.js":"module.exports = 1;"},"input":{"prompt":"run"}}',
      );
    } finally {
      fixture.close();
    }
  });

  it("preserves binding rejection and non-success responses", async () => {
    const fixture = sqliteFixture();
    const failure = new Error("binding failed");
    const generated = createNodeGeneratedCode({
      scopeId: "facet-a",
      storage: fixture.storage,
      fetcher: {
        fetch: async () => {
          throw failure;
        },
      },
    });
    const remoteResponse = new Response("remote detail", { status: 503 });
    const failingStatus = createNodeGeneratedCode({
      scopeId: "facet-b",
      storage: fixture.storage,
      fetcher: { fetch: async () => remoteResponse },
    });

    try {
      await expect(generated.invoke(request())).rejects.toBe(failure);
      await expect(failingStatus.invoke(request())).resolves.toBe(remoteResponse);
      expect(remoteResponse.status).toBe(503);
      expect(await remoteResponse.text()).toBe("remote detail");
    } finally {
      fixture.close();
    }
  });

  it("throws a typed unavailable error when the optional binding is absent", async () => {
    const fixture = sqliteFixture();
    const generated = createNodeGeneratedCode({ scopeId: "facet-a", storage: fixture.storage });
    try {
      await expect(generated.invoke(request())).rejects.toBeInstanceOf(
        NodeGeneratedCodeUnavailableError,
      );
    } finally {
      fixture.close();
    }
  });

  it("persists learned constructor modules across store instances", async () => {
    const fixture = sqliteFixture();
    const first = withFunctionRuntime(fixture.storage, "facet-a");
    const key = await first.learnFunction({
      kind: "function",
      params: ["value"],
      body: "return value + 1;",
    });
    const second = withFunctionRuntime(fixture.storage, "facet-a");

    try {
      const prepared = await second.prepare(Number.MAX_SAFE_INTEGER);
      expect(prepared.modules[`gen/${key}.js`]).toContain("return value + 1;");
      expect(
        prepared.functionIndex[
          nodeGeneratedFunctionSourceKey({
            kind: "function",
            params: ["value"],
            body: "return value + 1;",
          })
        ],
      ).toBe(`gen/${key}.js`);
      expect(prepared.moduleMapBytes).toBeGreaterThan(0);
      expect(prepared.omittedKeys).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it("stores large function identities and modules in bounded SQLite chunks", async () => {
    const fixture = sqliteFixture();
    const generated = withFunctionRuntime(fixture.storage, "facet-a");
    const entry = {
      kind: "function" as const,
      params: [],
      body: `return "${"x".repeat(80_000)}";`,
    };
    const key = await generated.learnFunction(entry);

    try {
      const prepared = await generated.prepare(Number.MAX_SAFE_INTEGER);
      expect(prepared.modules[`gen/${key}.js`]).toBeDefined();
      expect(prepared.functionIndex[nodeGeneratedFunctionSourceKey(entry)]).toBe(`gen/${key}.js`);
      expect(
        Array.from(
          fixture.storage.sql.exec(
            "SELECT part FROM node_generated_code_chunk_v1 WHERE scope_id = ? AND code_key = ?",
            "facet-a",
            key,
          ),
        ),
      ).toHaveLength(4);
      expect(
        Array.from(
          fixture.storage.sql.exec(
            "SELECT part FROM node_generated_function_index_chunk_v1 WHERE scope_id = ? AND code_key = ?",
            "facet-a",
            key,
          ),
        ),
      ).toHaveLength(4);
    } finally {
      fixture.close();
    }
  });

  it("rejects a generated source whose stored integrity digest no longer matches", async () => {
    const fixture = sqliteFixture();
    const generated = withFunctionRuntime(fixture.storage, "facet-a");
    const key = await generated.learnFunction({ kind: "function", params: [], body: "return 1;" });
    fixture.database
      .prepare(
        "UPDATE node_generated_code_chunk_v1 SET source = ? WHERE scope_id = ? AND code_key = ? AND part = 0",
      )
      .run("module.exports = function () { return 2; };", "facet-a", key);

    try {
      await expect(generated.prepare(Number.MAX_SAFE_INTEGER)).rejects.toBeInstanceOf(
        NodeGeneratedCodeIntegrityError,
      );
    } finally {
      fixture.close();
    }
  });

  it("rejects a corrupted SQLite constructor identity before next-boot selection", async () => {
    const fixture = sqliteFixture();
    const generated = withFunctionRuntime(fixture.storage, "facet-a");
    const key = await generated.learnFunction({ kind: "function", params: [], body: "return 1;" });
    fixture.database
      .prepare(
        "UPDATE node_generated_function_index_chunk_v1 SET source = ? WHERE scope_id = ? AND code_key = ? AND part = 0",
      )
      .run('["async",[],"return 1;"]', "facet-a", key);

    try {
      await expect(generated.prepare(Number.MAX_SAFE_INTEGER)).rejects.toBeInstanceOf(
        NodeGeneratedCodeIntegrityError,
      );
    } finally {
      fixture.close();
    }
  });

  it("honors the caller's remaining module-map byte budget deterministically", async () => {
    const fixture = sqliteFixture();
    const generated = withFunctionRuntime(fixture.storage, "facet-a");
    await generated.learnFunction({ kind: "function", params: [], body: "return 1;" });
    await generated.learnFunction({ kind: "async", params: ["input"], body: "return input;" });
    const complete = await generated.prepare(Number.MAX_SAFE_INTEGER);
    const [firstName, secondName] = Object.keys(complete.modules);
    expect(firstName).toBeDefined();
    expect(secondName).toBeDefined();
    const firstSource = complete.modules[firstName!];
    const firstCost =
      new TextEncoder().encode(firstName!).byteLength +
      new TextEncoder().encode(firstSource!).byteLength;

    try {
      const bounded = await generated.prepare(firstCost);
      expect(Object.keys(bounded.modules)).toEqual([firstName]);
      expect(bounded.moduleMapBytes).toBe(firstCost);
      expect(bounded.omittedKeys).toEqual([secondName!.slice("gen/".length, -".js".length)]);
      expect(Object.keys(bounded.functionIndex)).toHaveLength(1);
      const repeated = await generated.prepare(firstCost);
      expect(Object.keys(repeated.modules)).toEqual(Object.keys(bounded.modules));
      expect(repeated.omittedKeys).toEqual(bounded.omittedKeys);
      expect(repeated.moduleMapBytes).toBe(bounded.moduleMapBytes);
    } finally {
      fixture.close();
    }
  });

  it("keeps learned code inside its supplied facet scope", async () => {
    const fixture = sqliteFixture();
    const first = withFunctionRuntime(fixture.storage, "facet-a");
    const other = withFunctionRuntime(fixture.storage, "facet-b");
    await first.learnFunction({ kind: "function", params: [], body: "return 'private';" });

    try {
      expect(Object.keys((await other.prepare(Number.MAX_SAFE_INTEGER)).modules)).toEqual([]);
      expect(Object.keys((await other.prepare(Number.MAX_SAFE_INTEGER)).functionIndex)).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it("rejects traversal and ambiguous module paths before invoking the binding", async () => {
    const fixture = sqliteFixture();
    const generated = createNodeGeneratedCode({
      scopeId: "facet-a",
      storage: fixture.storage,
      fetcher: { fetch: async () => new Response(null, { status: 200 }) },
    });
    try {
      await expect(
        generated.invoke(
          request({
            mainModule: "../main.js",
            modules: { "../main.js": "" },
          }),
        ),
      ).rejects.toThrow("Invalid generated-code module name");
      await expect(
        generated.invoke(
          request({
            mainModule: "main.js",
            modules: { "main.js": "", "lib//value.js": "" },
          }),
        ),
      ).rejects.toThrow("Invalid generated-code module name");
      await expect(generated.invoke(request({ id: "é".repeat(65) }))).rejects.toThrow(
        "exceeds 100 UTF-8 bytes",
      );
      for (const id of ["é", "contains space", "underscore_id"]) {
        await expect(generated.invoke(request({ id }))).rejects.toThrow(
          "only ASCII letters, digits, and hyphens",
        );
      }
    } finally {
      fixture.close();
    }
  });

  it("rejects malformed request records, accessors, and non-JSON input before fetching", async () => {
    const fixture = sqliteFixture();
    let fetches = 0;
    const generated = createNodeGeneratedCode({
      scopeId: "facet-a",
      storage: fixture.storage,
      fetcher: {
        fetch: async () => {
          fetches++;
          return new Response(null);
        },
      },
    });
    const accessorInput = Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        throw new Error("must not run");
      },
    });
    const sparseInput: unknown[] = [];
    sparseInput.length = 1;

    try {
      await expect(generated.invoke(undefined as never)).rejects.toBeInstanceOf(
        NodeGeneratedCodeInputError,
      );
      await expect(generated.invoke(request({ input: accessorInput as never }))).rejects.toThrow(
        "accessors",
      );
      await expect(generated.invoke(request({ input: sparseInput as never }))).rejects.toThrow(
        "holes",
      );
      await expect(generated.invoke(request({ input: Number.NaN as never }))).rejects.toThrow(
        "valid JSON",
      );
      expect(fetches).toBe(0);
    } finally {
      fixture.close();
    }
  });

  it("routes every supported constructor kind through the prepared Nimbus boundary", async () => {
    const fixture = sqliteFixture();
    const calls: { kind: NodeGeneratedFunctionKind; params: readonly string[]; body: string }[] =
      [];
    const generated = createNodeGeneratedCode({
      scopeId: "facet-a",
      storage: fixture.storage,
      functionRuntime: {
        runtimeFunctionModule(kind, params, body) {
          calls.push({ kind, params: [...params], body });
          return testFunctionRuntime.runtimeFunctionModule(kind, params, body);
        },
      },
    });

    try {
      for (const kind of functionKinds) {
        await generated.learnFunction({ kind, params: ["value"], body: "return value;" });
      }
      expect(calls).toEqual(
        functionKinds.map((kind) => ({
          kind,
          params: ["value"],
          body: "return value;",
        })),
      );
      const prepared = await generated.prepare(Number.MAX_SAFE_INTEGER);
      expect(Object.keys(prepared.modules)).toHaveLength(functionKinds.length);
    } finally {
      fixture.close();
    }
  });

  it("leaves Nimbus parser errors unlearned and rejects malformed constructor entries", async () => {
    const fixture = sqliteFixture();
    const parserFailure = new SyntaxError("Arg string terminates parameters early");
    const generated = createNodeGeneratedCode({
      scopeId: "facet-a",
      storage: fixture.storage,
      functionRuntime: {
        runtimeFunctionModule() {
          throw parserFailure;
        },
      },
    });

    try {
      await expect(
        generated.learnFunction({
          kind: "function",
          params: ["value"],
          body: "return value;",
        }),
      ).rejects.toBe(parserFailure);
      const sparseParams: string[] = [];
      sparseParams.length = 1;
      await expect(
        generated.learnFunction({
          kind: "function" as NodeGeneratedFunctionKind,
          params: sparseParams,
          body: "return 1;",
        }),
      ).rejects.toThrow("missing fields or accessors");
      await expect(
        generated.learnFunction({
          kind: "invalid" as NodeGeneratedFunctionKind,
          params: [],
          body: "return 1;",
        }),
      ).rejects.toBeInstanceOf(NodeGeneratedCodeInputError);
      const rows = Array.from(
        fixture.storage.sql.exec("SELECT code_key FROM node_generated_code_v1"),
      );
      expect(rows).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it("reports a missing prepared Nimbus runtime without affecting native HTTP invocation", async () => {
    const fixture = sqliteFixture();
    const generated = createNodeGeneratedCode({
      scopeId: "facet-a",
      storage: fixture.storage,
      fetcher: { fetch: async () => new Response("ok", { status: 200 }) },
    });

    try {
      await expect(
        generated.learnFunction({
          kind: "function",
          params: [],
          body: "return 1;",
        }),
      ).rejects.toBeInstanceOf(NodeGeneratedCodeRuntimeUnavailableError);
      await expect(generated.invoke(request())).resolves.toMatchObject({ status: 200 });
    } finally {
      fixture.close();
    }
  });

  it("deduplicates identical learned source by its constructor kind and source", async () => {
    const fixture = sqliteFixture();
    const generated = withFunctionRuntime(fixture.storage, "facet-a");
    const entry = { kind: "function" as const, params: ["value"], body: "return value;" };

    try {
      const firstKey = await generated.learnFunction(entry);
      const duplicateKey = await generated.learnFunction(entry);
      const asyncKey = await generated.learnFunction({ ...entry, kind: "async" });
      expect(duplicateKey).toBe(firstKey);
      expect(asyncKey).not.toBe(firstKey);
      const prepared = await generated.prepare(Number.MAX_SAFE_INTEGER);
      expect(Object.keys(prepared.modules)).toEqual(
        [`gen/${asyncKey}.js`, `gen/${firstKey}.js`].sort(),
      );
    } finally {
      fixture.close();
    }
  });
});
