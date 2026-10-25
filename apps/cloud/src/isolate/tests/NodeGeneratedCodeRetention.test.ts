import { describe, expect, it } from "@effect/vitest";
import {
  createNodeGeneratedCode,
  nodeGeneratedFunctionSourceKey,
  type NodeGeneratedFunctionCode,
  type NodeGeneratedFunctionModuleRuntime,
} from "../NodeGeneratedCode.ts";
import type { FacetStorage } from "../../kernel/FacetSqliteStorage.ts";
import { nodeGeneratedCodeSqliteFixture } from "./generatedCodeFixture.ts";

const functionRuntime: NodeGeneratedFunctionModuleRuntime = {
  runtimeFunctionModule(_kind, _params, body) {
    return `module.exports = function () { return function () {${body}}; };`;
  },
};
const entry = (value: string): NodeGeneratedFunctionCode => ({
  kind: "function",
  params: [],
  body: `return '${value}';`,
});
const keyNames = (keys: string[]) => keys.map((key) => `gen/${key}.js`).sort();

describe("Node generated-code retention", () => {
  it("evicts the oldest retained entry, refreshes duplicates, and isolates scopes", async () => {
    const fixture = nodeGeneratedCodeSqliteFixture();
    const generated = createNodeGeneratedCode({
      storage: fixture.storage,
      scopeId: "a",
      functionRuntime,
      retention: { maxEntries: 2 },
    });
    const other = createNodeGeneratedCode({
      storage: fixture.storage,
      scopeId: "b",
      functionRuntime,
      retention: { maxEntries: 1 },
    });
    try {
      const otherKey = await other.learnFunction(entry("other"));
      const first = await generated.learnFunction(entry("first"));
      await generated.learnFunction(entry("second"));
      await generated.learnFunction(entry("first"));
      const third = await generated.learnFunction(entry("third"));
      expect(Object.keys((await generated.prepare(Number.MAX_SAFE_INTEGER)).modules)).toEqual(
        keyNames([first, third]),
      );
      expect(Object.keys((await other.prepare(Number.MAX_SAFE_INTEGER)).modules)).toEqual(
        keyNames([otherKey]),
      );
      expect(
        Array.from(
          fixture.storage.sql.exec(
            "SELECT code_key FROM node_generated_code_v1 WHERE scope_id = ?",
            "a",
          ),
        ),
      ).toHaveLength(2);
      expect(
        Array.from(
          fixture.storage.sql.exec(
            "SELECT code_key FROM node_generated_code_chunk_v1 WHERE scope_id = ?",
            "a",
          ),
        ),
      ).toHaveLength(2);
      expect(
        Array.from(
          fixture.storage.sql.exec(
            "SELECT code_key FROM node_generated_function_index_chunk_v1 WHERE scope_id = ?",
            "a",
          ),
        ),
      ).toHaveLength(2);
    } finally {
      fixture.close();
    }
  });

  it("bounds retained UTF-8 bytes and skips oversized source without evicting useful entries", async () => {
    const fixture = nodeGeneratedCodeSqliteFixture();
    const initial = createNodeGeneratedCode({
      storage: fixture.storage,
      scopeId: "bytes",
      functionRuntime,
    });
    const firstEntry = entry("é".repeat(40));
    const secondEntry = entry("å".repeat(40));
    const first = await initial.learnFunction(firstEntry);
    const map = await initial.prepare(Number.MAX_SAFE_INTEGER);
    const bytes =
      map.moduleMapBytes +
      new TextEncoder().encode(nodeGeneratedFunctionSourceKey(firstEntry)).byteLength +
      256;
    const generated = createNodeGeneratedCode({
      storage: fixture.storage,
      scopeId: "bytes",
      functionRuntime,
      retention: { maxEntries: 8, maxBytes: bytes },
    });
    try {
      expect(Object.keys((await generated.prepare(Number.MAX_SAFE_INTEGER)).modules)).toEqual(
        keyNames([first]),
      );
      const second = await generated.learnFunction(secondEntry);
      const oversized = await generated.learnFunction(entry("x".repeat(bytes)));
      const prepared = await generated.prepare(Number.MAX_SAFE_INTEGER);
      expect(Object.keys(prepared.modules)).toEqual(keyNames([second]));
      expect(prepared.modules[`gen/${oversized}.js`]).toBeUndefined();
      const rows = Array.from(
        fixture.storage.sql.exec(
          "SELECT sum(module_bytes + identity_bytes + 256) AS bytes FROM node_generated_code_retention_v1 WHERE scope_id = ?",
          "bytes",
        ),
      );
      expect(rows[0]?.bytes).toBe(bytes);
    } finally {
      fixture.close();
    }
  });

  it("prunes a larger existing cache before preparation and reads no source for a zero budget", async () => {
    const fixture = nodeGeneratedCodeSqliteFixture();
    const initial = createNodeGeneratedCode({
      storage: fixture.storage,
      scopeId: "shrink",
      functionRuntime,
    });
    const keys: string[] = [];
    for (let index = 0; index < 5; index++)
      keys.push(await initial.learnFunction(entry(String(index))));
    const reads: string[] = [];
    const storage: FacetStorage = {
      ...fixture.storage,
      sql: {
        ...fixture.storage.sql,
        exec(query, ...bindings) {
          if (/SELECT[\s\S]*FROM node_generated_(?:code|function_index)_chunk_v1/u.test(query))
            reads.push(query);
          return fixture.storage.sql.exec(query, ...bindings);
        },
      },
    };
    const bounded = createNodeGeneratedCode({
      storage,
      scopeId: "shrink",
      functionRuntime,
      retention: { maxEntries: 2 },
    });
    try {
      const zero = await bounded.prepare(0);
      expect(zero.modules).toEqual({});
      expect(zero.omittedKeys).toEqual(keys.slice(-2).sort());
      expect(reads).toEqual([]);
      expect(Object.keys((await bounded.prepare(Number.MAX_SAFE_INTEGER)).modules)).toEqual(
        keyNames(keys.slice(-2)),
      );
      expect(reads).toHaveLength(4);
    } finally {
      fixture.close();
    }
  });

  it("drops legacy unaccounted source in SQLite without reconstructing it", async () => {
    const fixture = nodeGeneratedCodeSqliteFixture();
    const initial = createNodeGeneratedCode({
      storage: fixture.storage,
      scopeId: "legacy",
      functionRuntime,
    });
    const key = await initial.learnFunction(entry("legacy"));
    fixture.storage.sql.exec(
      "DELETE FROM node_generated_code_retention_v1 WHERE scope_id = ?",
      "legacy",
    );
    fixture.storage.sql.exec(
      "UPDATE node_generated_code_chunk_v1 SET source = ? WHERE scope_id = ?",
      "x".repeat(200_000),
      "legacy",
    );
    let sourceReads = 0;
    const storage: FacetStorage = {
      ...fixture.storage,
      sql: {
        ...fixture.storage.sql,
        exec(query, ...bindings) {
          if (/SELECT[\s\S]*FROM node_generated_(?:code|function_index)_chunk_v1/u.test(query))
            sourceReads++;
          return fixture.storage.sql.exec(query, ...bindings);
        },
      },
    };
    const bounded = createNodeGeneratedCode({
      storage,
      scopeId: "legacy",
      functionRuntime,
      retention: { maxEntries: 1, maxBytes: 1024 },
    });
    try {
      expect((await bounded.prepare(0)).omittedKeys).toEqual([]);
      expect((await bounded.prepare(Number.MAX_SAFE_INTEGER)).modules).toEqual({});
      expect(sourceReads).toBe(0);
      expect(
        Array.from(
          fixture.storage.sql.exec(
            "SELECT code_key FROM node_generated_code_v1 WHERE code_key = ?",
            key,
          ),
        ),
      ).toEqual([]);
      expect(
        Array.from(
          fixture.storage.sql.exec(
            "SELECT code_key FROM node_generated_code_chunk_v1 WHERE code_key = ?",
            key,
          ),
        ),
      ).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it("rolls back a failed replacement without evicting the retained working entry", async () => {
    const fixture = nodeGeneratedCodeSqliteFixture();
    const generated = createNodeGeneratedCode({
      storage: fixture.storage,
      scopeId: "atomic",
      functionRuntime,
      retention: { maxEntries: 1 },
    });
    try {
      const key = await generated.learnFunction(entry("kept"));
      fixture.storage.sql.exec(
        "CREATE TRIGGER fail_generated_write BEFORE INSERT ON node_generated_code_chunk_v1 BEGIN SELECT RAISE(ABORT, 'fixture write failed'); END",
      );
      await expect(generated.learnFunction(entry("failed"))).rejects.toThrow(
        "fixture write failed",
      );
      expect(Object.keys((await generated.prepare(Number.MAX_SAFE_INTEGER)).modules)).toEqual(
        keyNames([key]),
      );
      fixture.storage.sql.exec("DROP TRIGGER fail_generated_write");
      const next = await generated.learnFunction(entry("next"));
      expect(Object.keys((await generated.prepare(Number.MAX_SAFE_INTEGER)).modules)).toEqual(
        keyNames([next]),
      );
    } finally {
      fixture.close();
    }
  });

  it("supports disabling retention and rejects invalid limits", async () => {
    const fixture = nodeGeneratedCodeSqliteFixture();
    const disabled = createNodeGeneratedCode({
      storage: fixture.storage,
      scopeId: "off",
      functionRuntime,
      retention: { maxEntries: 0 },
    });
    try {
      await disabled.learnFunction(entry("skipped"));
      expect((await disabled.prepare(Number.MAX_SAFE_INTEGER)).modules).toEqual({});
      expect(() =>
        createNodeGeneratedCode({
          storage: fixture.storage,
          scopeId: "invalid",
          retention: { maxBytes: -1 },
        }),
      ).toThrow(/retention limits/);
    } finally {
      fixture.close();
    }
  });
});
