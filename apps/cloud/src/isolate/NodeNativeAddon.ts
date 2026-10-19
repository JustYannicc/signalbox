export interface NodeNativeAddonDeclaration {
  readonly specifier: string;
  readonly members: readonly string[];
}

export interface NodeNativeAddonCall {
  readonly addon: string;
  readonly member: string;
  readonly args: readonly unknown[];
}

export type NodeNativeAddonInvoker = (call: NodeNativeAddonCall) => unknown;

export class NodeCapabilityNeedsMachineError extends Error {
  readonly code = "ERR_NODE_CAPABILITY_NEEDS_MACHINE";
  readonly addon: string;
  readonly member: string;

  constructor(addon: string, member: string) {
    super(`Native capability needs a machine: ${addon}#${member}`);
    this.name = "NodeCapabilityNeedsMachineError";
    this.addon = addon;
    this.member = member;
  }
}

export function createNodeNativeAddonModules(
  declarations: readonly NodeNativeAddonDeclaration[],
  invoke: NodeNativeAddonInvoker = invokeNativeAddon,
) {
  const modules = new Map<string, object>();
  for (const declaration of declarations) {
    if (!declaration.specifier.endsWith(".node")) {
      throw new TypeError("Native addon specifiers must end in .node");
    }
    if (modules.has(declaration.specifier))
      throw new TypeError("Duplicate native addon declaration");
    const addon = declaration.specifier;
    const module: Record<string, (...args: readonly unknown[]) => unknown> = Object.create(null);
    for (const member of declaration.members) {
      if (!member || Object.hasOwn(module, member))
        throw new TypeError("Invalid native addon member");
      module[member] = (...args) => invoke({ addon, member, args });
    }
    modules.set(declaration.specifier, Object.freeze(module));
  }
  return modules as ReadonlyMap<string, object>;
}

function invokeNativeAddon({ addon, member }: NodeNativeAddonCall): never {
  throw new NodeCapabilityNeedsMachineError(addon, member);
}
