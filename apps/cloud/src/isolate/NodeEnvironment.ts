import { NodeModuleUnavailableError, type NodePreparedModuleResolver } from "./NodeModule.ts";
import {
  createNodeNativeAddonModules,
  type NodeNativeAddonDeclaration,
} from "./NodeNativeAddon.ts";

export type NodeEnvironmentPackage = "undici" | "yaml";

export interface NodeEnvironmentOptions {
  /** Actual bundled package exports, loaded once before release evaluation. */
  readonly packages: Readonly<Partial<Record<NodeEnvironmentPackage, object>>>;
  readonly addons: readonly NodeNativeAddonDeclaration[];
  readonly prepared?: NodePreparedModuleResolver;
}

export function createNodeEnvironmentResolver(
  options: NodeEnvironmentOptions,
): NodePreparedModuleResolver {
  const packages = new Map(Object.entries(options.packages));
  for (const [name, value] of packages) {
    if (name !== "undici" && name !== "yaml")
      throw new TypeError(`Unknown environment package: ${name}`);
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
      throw new TypeError(`Environment package ${name} needs its actual exports`);
    }
  }
  const addons = createNodeNativeAddonModules(options.addons);
  return (specifier, referrer) => {
    if (packages.has(specifier)) return packages.get(specifier);
    if (addons.has(specifier)) return addons.get(specifier);
    if (options.prepared) return options.prepared(specifier, referrer);
    throw new NodeModuleUnavailableError("require", specifier);
  };
}
