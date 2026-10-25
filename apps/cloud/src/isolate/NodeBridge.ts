import { canonicalNodeBuiltin, type NodeBuiltinName } from "./NodeBuiltinMap.ts";

const REGISTRY_NAME = "signalbox.nodeBridge.v1";
const REGISTRY_KEY = Symbol.for(REGISTRY_NAME);

export class NodeBridgeError extends Error {
  readonly code:
    | "NODE_BUILTIN_UNKNOWN"
    | "NODE_BUILTIN_UNAVAILABLE"
    | "NODE_BRIDGE_ALIAS_CONFLICT"
    | "NODE_BRIDGE_ALREADY_INSTALLED"
    | "NODE_BRIDGE_OWNERSHIP_LOST";

  constructor(code: NodeBridgeError["code"], message: string) {
    super(message);
    this.name = "NodeBridgeError";
    this.code = code;
  }
}

export function createNodeBridge(modules: Readonly<Record<string, object>>) {
  const canonical = new Map<NodeBuiltinName, object>();
  for (const [specifier, value] of Object.entries(modules)) {
    const name = canonicalNodeBuiltin(specifier);
    if (!name)
      throw new NodeBridgeError("NODE_BUILTIN_UNKNOWN", `Unknown Node builtin: ${specifier}`);
    if ((typeof value !== "object" || value === null) && typeof value !== "function") {
      throw new TypeError(`Node builtin ${specifier} must be a module object`);
    }
    if (canonical.has(name) && canonical.get(name) !== value) {
      throw new NodeBridgeError("NODE_BRIDGE_ALIAS_CONFLICT", `Conflicting Node aliases: ${name}`);
    }
    canonical.set(name, value);
  }
  const fs = canonical.get("fs");
  const promises: unknown = fs && Reflect.get(fs, "promises");
  if (fs && canonical.has("fs/promises") && canonical.get("fs/promises") !== promises) {
    throw new NodeBridgeError("NODE_BRIDGE_ALIAS_CONFLICT", "fs/promises differs from fs.promises");
  }
  if (promises !== undefined) {
    if ((typeof promises !== "object" || promises === null) && typeof promises !== "function") {
      throw new TypeError("fs.promises must be a module object");
    }
    canonical.set("fs/promises", promises);
  }
  return Object.freeze({
    names: Object.freeze([...canonical.keys()].sort()),
    require(specifier: string): object {
      const name = canonicalNodeBuiltin(specifier);
      if (!name)
        throw new NodeBridgeError("NODE_BUILTIN_UNKNOWN", `Unknown Node builtin: ${specifier}`);
      const value = canonical.get(name);
      if (!value) {
        throw new NodeBridgeError(
          "NODE_BUILTIN_UNAVAILABLE",
          `Node builtin is not installed: ${name}`,
        );
      }
      return value;
    },
  });
}

export type NodeBridge = ReturnType<typeof createNodeBridge>;

export function installNodeBridge(bridge: NodeBridge) {
  if (Object.hasOwn(globalThis, REGISTRY_KEY)) {
    throw new NodeBridgeError(
      "NODE_BRIDGE_ALREADY_INSTALLED",
      "A Node bridge already owns this Worker. Use a separate Worker for another host.",
    );
  }
  Object.defineProperty(globalThis, REGISTRY_KEY, { value: bridge, configurable: true });
  let restored = false;
  return {
    restore() {
      if (restored) return;
      if (Reflect.get(globalThis, REGISTRY_KEY) !== bridge) {
        throw new NodeBridgeError("NODE_BRIDGE_OWNERSHIP_LOST", "Node bridge installation changed");
      }
      if (!Reflect.deleteProperty(globalThis, REGISTRY_KEY)) {
        throw new NodeBridgeError("NODE_BRIDGE_OWNERSHIP_LOST", "Node bridge cannot be removed");
      }
      restored = true;
    },
  };
}

export function createNodeBridgeLayerModules(names: readonly NodeBuiltinName[]) {
  const modules: Record<string, string> = {};
  for (const specifier of names) {
    const name = canonicalNodeBuiltin(specifier);
    if (!name)
      throw new NodeBridgeError("NODE_BUILTIN_UNKNOWN", `Unknown Node builtin: ${specifier}`);
    // CJS keeps require() identity; esbuild supplies ESM default and named access.
    // Bridge implementations are bundled separately, so their native imports cannot recurse here.
    const source = `const bridge = globalThis[Symbol.for(${JSON.stringify(REGISTRY_NAME)})];
if (!bridge) {
  const error = new Error("Install the Node bridge before importing the release");
  error.code = "NODE_BRIDGE_NOT_INSTALLED";
  throw error;
}
module.exports = bridge.require(${JSON.stringify(name)});
`;
    modules[name] = source;
    modules[`node:${name}`] = source;
  }
  return Object.freeze(modules);
}
