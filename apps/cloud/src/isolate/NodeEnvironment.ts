import { NodeModuleUnavailableError, type NodePreparedModuleResolver } from "./NodeModule.ts";
import {
  createNodeNativeAddonModules,
  type NodeNativeAddonDeclaration,
  type NodeNativeAddonInvoker,
} from "./NodeNativeAddon.ts";

export type NodeEnvironmentPackage = "undici" | "yaml" | "ws" | "node-fetch" | "bun:jsc";

const environmentPackages = new Set<NodeEnvironmentPackage>([
  "undici",
  "yaml",
  "ws",
  "node-fetch",
  "bun:jsc",
]);

export interface NodeEnvironmentOptions {
  /** Actual exports loaded by the environment before the release evaluates. */
  readonly packages: Readonly<Partial<Record<NodeEnvironmentPackage, object>>>;
  readonly addons: readonly NodeNativeAddonDeclaration[];
  readonly prepared?: NodePreparedModuleResolver;
  /** The host preserves each declared member's synchronous or asynchronous return contract. */
  readonly invokeNativeAddon?: NodeNativeAddonInvoker;
}

export function createNodeEnvironmentResolver(
  options: NodeEnvironmentOptions,
): NodePreparedModuleResolver {
  const packages = new Map(Object.entries(options.packages));
  for (const [name, value] of packages) {
    if (!environmentPackages.has(name as NodeEnvironmentPackage))
      throw new TypeError(`Unknown environment package: ${name}`);
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
      throw new TypeError(`Environment package ${name} needs its actual exports`);
    }
  }
  const addons = createNodeNativeAddonModules(options.addons, options.invokeNativeAddon);
  return (specifier, referrer) => {
    if (packages.has(specifier)) return packages.get(specifier);
    if (addons.has(specifier)) return addons.get(specifier);
    if (options.prepared) return options.prepared(specifier, referrer);
    throw new NodeModuleUnavailableError("require", specifier);
  };
}
