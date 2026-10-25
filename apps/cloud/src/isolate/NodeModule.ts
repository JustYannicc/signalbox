// @effect-diagnostics nodeBuiltinImport:off - URL conversion is pure; resolution stays with the prepared module graph.
import * as NodeURL from "node:url";
import { canonicalNodeBuiltin, NODE_BUILTIN_ROUTES } from "./NodeBuiltinMap.ts";
import type { NodeBridge } from "./NodeBridge.ts";

export type NodePreparedModuleResolver = (specifier: string, referrer: string) => unknown;
export type NodePreparedModuleResolve = (specifier: string, referrer: string) => string;

export class NodeModuleUnavailableError extends Error {
  readonly code = "ERR_NODE_PREPARED_MODULE_UNAVAILABLE";
  readonly operation: string;
  readonly specifier: string | undefined;

  constructor(operation: string, specifier?: string) {
    super(
      `Prepared module graph does not provide ${operation}${specifier === undefined ? "" : `: ${specifier}`}`,
    );
    this.name = "NodeModuleUnavailableError";
    this.operation = operation;
    this.specifier = specifier;
  }
}

/** The resolver is supplied by the prepared release, never by workerd's native filesystem. */
export function createNodeModule(
  bridge: Pick<NodeBridge, "require">,
  resolver?: NodePreparedModuleResolver,
  resolvePrepared?: NodePreparedModuleResolve,
) {
  function unavailable(operation: string): never {
    throw new NodeModuleUnavailableError(operation);
  }

  function createRequire(filename: string | URL) {
    const referrer = requireReferrer(filename);
    const require = (specifier: string): unknown => {
      assertSpecifier(specifier);
      if (canonicalNodeBuiltin(specifier) !== undefined || specifier.startsWith("node:")) {
        return bridge.require(specifier);
      }
      if (!resolver) throw new NodeModuleUnavailableError("require", specifier);
      return resolver(specifier, referrer);
    };
    const resolve = (specifier: string): string => {
      assertSpecifier(specifier);
      if (canonicalNodeBuiltin(specifier) !== undefined) return specifier;
      if (specifier.startsWith("node:")) {
        bridge.require(specifier);
        throw new NodeModuleUnavailableError("resolve", specifier);
      }
      if (!resolvePrepared) throw new NodeModuleUnavailableError("resolve", specifier);
      return resolvePrepared(specifier, referrer);
    };
    Object.assign(resolve, {
      paths: (specifier: string) => {
        assertSpecifier(specifier);
        if (canonicalNodeBuiltin(specifier) !== undefined) return null;
        throw new NodeModuleUnavailableError("resolve.paths", specifier);
      },
    });
    Object.assign(require, { resolve });
    for (const key of ["cache", "extensions", "main"]) {
      Object.defineProperty(require, key, {
        get: () => unavailable(`require.${key}`),
      });
    }
    return require as typeof require & { resolve: typeof resolve };
  }

  function Module(): never {
    return unavailable("Module construction");
  }
  const module = Object.assign(Module, {
    createRequire,
    isBuiltin: (specifier: string) =>
      typeof specifier === "string" && canonicalNodeBuiltin(specifier) !== undefined,
    // Classification only; the bridge remains authoritative about installed capabilities.
    builtinModules: Object.freeze(Object.keys(NODE_BUILTIN_ROUTES)),
    _load: () => unavailable("Module._load"),
    _resolveFilename: () => unavailable("Module._resolveFilename"),
    register: () => unavailable("module.register"),
    registerHooks: () => unavailable("module.registerHooks"),
    syncBuiltinESMExports: () => unavailable("module.syncBuiltinESMExports"),
  });
  return Object.freeze(Object.assign(module, { Module: module, default: module }));
}

function assertSpecifier(specifier: string): void {
  if (typeof specifier !== "string") throw new TypeError("Module specifier must be a string");
  if (specifier.length === 0) throw new TypeError("Module specifier must not be empty");
}

function requireReferrer(filename: string | URL): string {
  if (typeof filename === "string" && filename.startsWith("/")) {
    return filename;
  }
  const url = typeof filename === "string" ? new URL(filename) : filename;
  if (!(url instanceof URL) || url.protocol !== "file:") {
    throw new TypeError("createRequire needs an absolute guest path or file URL");
  }
  return NodeURL.fileURLToPath(url);
}
