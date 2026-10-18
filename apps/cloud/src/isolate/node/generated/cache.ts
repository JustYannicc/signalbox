import { readGeneratedCodeChunks, splitGeneratedCodeSource } from "./chunks.ts";
import type { FacetStorage } from "../../../kernel/FacetSqliteStorage.ts";
import {
  NodeGeneratedCodeIntegrityError,
  NodeGeneratedCodeInputError,
  NodeGeneratedCodeRuntimeUnavailableError,
} from "./errors.ts";
import { generatedCodeUtf8ByteLength, sha256Hex } from "./graph.ts";
import {
  generatedCodePromise,
  generatedCodeRealmIsSafe,
  generatedCodePreparationRealmIsSafe,
} from "./generation-realm.ts";
import {
  createGeneratedCodeRetention,
  type NodeGeneratedCodeRetentionLimits,
} from "./retention.ts";
import {
  nodeGeneratedFunctionSourceKey,
  normalizeNodeGeneratedFunctionCode,
  runtimeCodeModuleName,
  type NodeGeneratedFunctionModuleRuntime,
  type NodeGeneratedFunctionCode,
} from "./runtimeFunctionModule.ts";

const create = Object.create;
const freeze = Object.freeze;
const defineProperty = Object.defineProperty;
const safeInteger = Number.isSafeInteger;

const tableName = "node_generated_code_v1";
const chunksTableName = "node_generated_code_chunk_v1";
const functionIndexTableName = "node_generated_function_index_v1";
const functionIndexChunksTableName = "node_generated_function_index_chunk_v1";

export interface NodeGeneratedCodeModuleMap {
  readonly modules: Readonly<Record<string, string>>;
  /** Nimbus identity source to staged module name; local sidecar, excluded from map bytes and HTTP. */
  readonly functionIndex: Readonly<Record<string, string>>;
  /** UTF-8 bytes of each staged module name plus its source; the caller budget uses the same unit. */
  readonly moduleMapBytes: number;
  /** Content keys omitted because they did not fit the supplied remaining budget. */
  readonly omittedKeys: readonly string[];
}

export interface NodeGeneratedCodeCache {
  learnFunction(entry: NodeGeneratedFunctionCode): Promise<string>;
  prepare(moduleMapByteBudget: number): Promise<NodeGeneratedCodeModuleMap>;
}

export function createNodeGeneratedCodeCache(
  storage: FacetStorage,
  scopeId: string,
  functionRuntime?: NodeGeneratedFunctionModuleRuntime,
  limits?: NodeGeneratedCodeRetentionLimits,
): NodeGeneratedCodeCache {
  storage.sql.exec(
    `CREATE TABLE IF NOT EXISTS ${tableName} (
      scope_id TEXT NOT NULL,
      code_key TEXT NOT NULL,
      module_source_hash TEXT NOT NULL,
      chunk_count INTEGER NOT NULL,
      PRIMARY KEY (scope_id, code_key)
    )`,
  );

  storage.sql.exec(
    `CREATE TABLE IF NOT EXISTS ${chunksTableName} (
      scope_id TEXT NOT NULL,
      code_key TEXT NOT NULL,
      part INTEGER NOT NULL,
      source TEXT NOT NULL,
      PRIMARY KEY (scope_id, code_key, part)
    )`,
  );
  storage.sql.exec(
    `CREATE TABLE IF NOT EXISTS ${functionIndexTableName} (
      scope_id TEXT NOT NULL,
      code_key TEXT NOT NULL,
      identity_chunk_count INTEGER NOT NULL,
      PRIMARY KEY (scope_id, code_key)
    )`,
  );
  storage.sql.exec(
    `CREATE TABLE IF NOT EXISTS ${functionIndexChunksTableName} (
      scope_id TEXT NOT NULL,
      code_key TEXT NOT NULL,
      part INTEGER NOT NULL,
      source TEXT NOT NULL,
      PRIMARY KEY (scope_id, code_key, part)
    )`,
  );

  const retention = createGeneratedCodeRetention(storage, scopeId, limits);
  const cache: NodeGeneratedCodeCache = {
    learnFunction: (entry) =>
      generatedCodePromise(
        (async () => {
          const stableEntry = normalizeNodeGeneratedFunctionCode(entry);
          if (!functionRuntime) throw new NodeGeneratedCodeRuntimeUnavailableError();

          const identitySource = nodeGeneratedFunctionSourceKey(stableEntry);
          const key = await sha256Hex(identitySource);
          const identityBytes = generatedCodeUtf8ByteLength(identitySource);
          if (!retention.fits(0, identityBytes)) return key;
          if (!generatedCodeRealmIsSafe()) return key;
          const moduleSource = functionRuntime.runtimeFunctionModule(
            stableEntry.kind,
            stableEntry.params,
            stableEntry.body,
          );
          if (typeof moduleSource !== "string" || moduleSource.length === 0) {
            throw new NodeGeneratedCodeInputError(
              "Nimbus returned an empty generated-function module",
            );
          }
          const moduleBytes =
            generatedCodeUtf8ByteLength(runtimeCodeModuleName(key)) +
            generatedCodeUtf8ByteLength(moduleSource);
          if (!retention.fits(moduleBytes, identityBytes)) return key;
          const moduleSourceHash = await sha256Hex(moduleSource);
          // Guest work can change the realm during either digest await.
          if (!generatedCodeRealmIsSafe()) return key;
          const chunks = splitGeneratedCodeSource(moduleSource);
          const identityChunks = splitGeneratedCodeSource(identitySource);

          retention.retain(key, moduleBytes, identityBytes, () => {
            storage.sql.exec(
              `INSERT INTO ${tableName} (scope_id, code_key, module_source_hash, chunk_count)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(scope_id, code_key) DO UPDATE SET
             module_source_hash = excluded.module_source_hash,
             chunk_count = excluded.chunk_count`,
              scopeId,
              key,
              moduleSourceHash,
              chunks.length,
            );
            storage.sql.exec(
              `DELETE FROM ${chunksTableName} WHERE scope_id = ? AND code_key = ?`,
              scopeId,
              key,
            );
            storage.sql.exec(
              `INSERT INTO ${functionIndexTableName} (scope_id, code_key, identity_chunk_count)
           VALUES (?, ?, ?)
           ON CONFLICT(scope_id, code_key) DO UPDATE SET identity_chunk_count = excluded.identity_chunk_count`,
              scopeId,
              key,
              identityChunks.length,
            );
            storage.sql.exec(
              `DELETE FROM ${functionIndexChunksTableName} WHERE scope_id = ? AND code_key = ?`,
              scopeId,
              key,
            );
            for (let part = 0; part < identityChunks.length; part++) {
              storage.sql.exec(
                `INSERT INTO ${functionIndexChunksTableName} (scope_id, code_key, part, source)
             VALUES (?, ?, ?, ?)`,
                scopeId,
                key,
                part,
                identityChunks[part]!,
              );
            }
            for (let part = 0; part < chunks.length; part++) {
              storage.sql.exec(
                `INSERT INTO ${chunksTableName} (scope_id, code_key, part, source) VALUES (?, ?, ?, ?)`,
                scopeId,
                key,
                part,
                chunks[part]!,
              );
            }
          });
          return key;
        })(),
      ),
    prepare: (moduleMapByteBudget) =>
      generatedCodePromise(
        (async () => {
          if (!safeInteger(moduleMapByteBudget) || moduleMapByteBudget < 0) {
            throw new NodeGeneratedCodeInputError(
              "Generated-code module map budget must be a non-negative safe integer",
            );
          }
          if (!generatedCodePreparationRealmIsSafe()) return emptyPreparedMap();
          const rows = retention.entries();
          const modules: Record<string, string> = create(null) as Record<string, string>;
          const functionIndex: Record<string, string> = create(null) as Record<string, string>;
          const omittedKeys: string[] = [];
          let moduleMapBytes = 0;
          for (let index = 0; index < rows.length; index++) {
            const row = rows[index]!;
            const key = row.code_key;
            const moduleSourceHash = row.module_source_hash;
            const chunkCount = row.chunk_count;
            const moduleBytes = row.module_bytes;
            const identityBytes = row.identity_bytes;
            if (
              typeof key !== "string" ||
              !/^[0-9a-f]{64}$/u.test(key) ||
              typeof moduleSourceHash !== "string" ||
              !/^[0-9a-f]{64}$/u.test(moduleSourceHash) ||
              typeof chunkCount !== "number" ||
              !Number.isSafeInteger(chunkCount) ||
              chunkCount < 1 ||
              typeof moduleBytes !== "number" ||
              typeof identityBytes !== "number"
            ) {
              throw new NodeGeneratedCodeIntegrityError(typeof key === "string" ? key : "invalid");
            }
            if (moduleBytes > moduleMapByteBudget - moduleMapBytes) {
              defineProperty(omittedKeys, omittedKeys.length, {
                value: key,
                writable: true,
                enumerable: true,
                configurable: true,
              });
              continue;
            }
            const identityRows = Array.from(
              storage.sql.exec(
                `SELECT identity_chunk_count FROM ${functionIndexTableName}
           WHERE scope_id = ? AND code_key = ?`,
                scopeId,
                key,
              ),
            );
            const identityRow = identityRows[0];
            const identitySource = readGeneratedCodeChunks(
              storage,
              scopeId,
              functionIndexChunksTableName,
              key,
              identityRow?.identity_chunk_count,
              identityBytes,
            );
            const identityHash = await sha256Hex(identitySource);
            if (!generatedCodePreparationRealmIsSafe()) return emptyPreparedMap();
            if (identityHash !== key) throw new NodeGeneratedCodeIntegrityError(key);
            const name = runtimeCodeModuleName(key);
            const moduleSource = readGeneratedCodeChunks(
              storage,
              scopeId,
              chunksTableName,
              key,
              chunkCount,
              moduleBytes - generatedCodeUtf8ByteLength(name),
            );
            const moduleHash = await sha256Hex(moduleSource);
            if (!generatedCodePreparationRealmIsSafe()) return emptyPreparedMap();
            if (moduleHash !== moduleSourceHash) throw new NodeGeneratedCodeIntegrityError(key);
            const cost = moduleBytes;
            modules[name] = moduleSource;
            functionIndex[identitySource] = name;
            moduleMapBytes += cost;
          }
          return preparedMap(modules, functionIndex, moduleMapBytes, omittedKeys);
        })(),
      ),
  };
  return Object.freeze(cache);
}

function emptyPreparedMap(): NodeGeneratedCodeModuleMap {
  return preparedMap(
    create(null) as Record<string, string>,
    create(null) as Record<string, string>,
    0,
    [],
  );
}

function preparedMap(
  modules: Record<string, string>,
  functionIndex: Record<string, string>,
  moduleMapBytes: number,
  omittedKeys: string[],
): NodeGeneratedCodeModuleMap {
  // Async resolution probes "then" on its result. No inherited guest binding may run.
  const result = create(null) as {
    modules: Readonly<Record<string, string>>;
    functionIndex: Readonly<Record<string, string>>;
    moduleMapBytes: number;
    omittedKeys: readonly string[];
  };
  result.modules = freeze(modules);
  result.functionIndex = freeze(functionIndex);
  result.moduleMapBytes = moduleMapBytes;
  result.omittedKeys = freeze(omittedKeys);
  return freeze(result);
}
