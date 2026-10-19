import type { FacetStorage } from "../kernel/FacetSqliteStorage.ts";
export { createNodeGeneratedCodeFetcher } from "./node/generated/invocation-fetcher.ts";
export { NodeGeneratedCodeCleanupError } from "./node/generated/invocation-errors.ts";
export type {
  NodeGeneratedCodeInvocation,
  NodeGeneratedCodeOpenPort,
} from "./node/generated/invocation.ts";
import { generatedCodePromise } from "./node/generated/generation-realm.ts";
import type { NodeGeneratedCodeRetentionLimits } from "./node/generated/retention.ts";
export { NODE_GENERATED_CODE_DEFAULT_RETENTION } from "./node/generated/retention.ts";
export type { NodeGeneratedCodeRetentionLimits } from "./node/generated/retention.ts";
import {
  createNodeGeneratedCodeCache,
  type NodeGeneratedCodeModuleMap,
} from "./node/generated/cache.ts";
import {
  nodeGeneratedCodeInvokeBody,
  nodeGeneratedModuleGraphDigest,
  NODE_GENERATED_CODE_CALLER_ID_MAX_BYTES,
  validateNodeGeneratedCodeInvokeInput,
  type NodeGeneratedCodeInvokeInput,
  type NodeGeneratedJsonValue,
} from "./node/generated/graph.ts";
import {
  NodeGeneratedCodeInputError,
  NodeGeneratedCodeIntegrityError,
  NodeGeneratedCodeRuntimeUnavailableError,
  NodeGeneratedCodeUnavailableError,
} from "./node/generated/errors.ts";
import type {
  NodeGeneratedFunctionCode,
  NodeGeneratedFunctionKind,
  NodeGeneratedFunctionModuleRuntime,
} from "./node/generated/runtimeFunctionModule.ts";

export type {
  NodeGeneratedCodeInvokeInput,
  NodeGeneratedCodeModuleMap,
  NodeGeneratedFunctionCode,
  NodeGeneratedFunctionKind,
  NodeGeneratedFunctionModuleRuntime,
  NodeGeneratedJsonValue,
};
export {
  NODE_GENERATED_CODE_CALLER_ID_MAX_BYTES,
  NodeGeneratedCodeInputError,
  NodeGeneratedCodeIntegrityError,
  NodeGeneratedCodeRuntimeUnavailableError,
  NodeGeneratedCodeUnavailableError,
};
export { nodeGeneratedFunctionSourceKey } from "./node/generated/runtimeFunctionModule.ts";

/** The narrow part of Cloudflare's Fetcher relied on by this adapter. */
export interface NodeGeneratedCodeFetcher {
  fetch(request: Request): Promise<Response>;
}

export interface NodeGeneratedCodeOptions {
  readonly fetcher?: NodeGeneratedCodeFetcher;
  readonly storage: FacetStorage;
  /** Parent supplied session/facet scope for SQLite partitioning; never sent to the binding. */
  readonly scopeId: string;
  /** Prepared Nimbus commonjs-cell runtime supplied by the VM builder. */
  readonly functionRuntime?: NodeGeneratedFunctionModuleRuntime;
  /** Per-facet retention. Newest entries evict older ones; oversized entries are skipped. */
  readonly retention?: NodeGeneratedCodeRetentionLimits;
}

export interface NodeGeneratedCode {
  /** The binding's Response is returned unchanged. Callers own status and JSON decoding. */
  invoke(
    input: NodeGeneratedCodeInvokeInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Response>;
  /**
   * Called after an interpreter Function constructor succeeds. The VM owner
   * must observe this promise before the facet can prepare its next boot.
   * Returns the identity key even when retention limits skip the entry.
   */
  learnFunction(entry: NodeGeneratedFunctionCode): Promise<string>;
  /**
   * Stages the local gen/<sha>.js map and its synchronous Nimbus identity
   * index for the modules that fit this caller-supplied remaining budget.
   */
  prepare(moduleMapByteBudget: number): Promise<NodeGeneratedCodeModuleMap>;
}

const endpoint = "https://code-generation.invalid/invoke";

export function createNodeGeneratedCode(options: NodeGeneratedCodeOptions): NodeGeneratedCode {
  const scopeId = validateScopeId(options.scopeId);
  const cache = createNodeGeneratedCodeCache(
    options.storage,
    scopeId,
    options.functionRuntime,
    options.retention,
  );
  const fetcher = options.fetcher;

  const generated: NodeGeneratedCode = {
    invoke: (input, invokeOptions) =>
      generatedCodePromise(
        (async () => {
          const signal = invokeOptions?.signal;
          if (signal?.aborted) throw signal.reason;
          const validated = validateNodeGeneratedCodeInvokeInput(input);
          if (!fetcher) throw new NodeGeneratedCodeUnavailableError();
          return generatedCodePromise(
            fetcher.fetch(
              new Request(endpoint, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: nodeGeneratedCodeInvokeBody(validated),
                ...(signal ? { signal } : {}),
              }),
            ),
          );
        })(),
      ),
    learnFunction: cache.learnFunction,
    prepare: cache.prepare,
  };
  return Object.freeze(generated);
}

/** Local graph digest helper for contract checks; never sent as the caller id. */
export function nodeGeneratedCodeGraphDigest(
  input: Pick<NodeGeneratedCodeInvokeInput, "mainModule" | "modules">,
): Promise<string> {
  return generatedCodePromise(
    (async () => nodeGeneratedModuleGraphDigest(input.mainModule, input.modules))(),
  );
}

function validateScopeId(scopeId: string): string {
  if (typeof scopeId !== "string" || scopeId.length === 0) {
    throw new NodeGeneratedCodeInputError("Generated-code scope id must be a non-empty string");
  }
  return scopeId;
}
