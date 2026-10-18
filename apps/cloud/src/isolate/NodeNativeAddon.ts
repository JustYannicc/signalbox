export interface NodeNativeAddonDeclaration {
  readonly specifier: string;
  readonly members: readonly string[];
}

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

export function createNodeNativeAddonModules(declarations: readonly NodeNativeAddonDeclaration[]) {
  const modules = new Map<string, object>();
  for (const declaration of declarations) {
    if (!declaration.specifier.endsWith(".node")) {
      throw new TypeError("Native addon specifiers must end in .node");
    }
    if (modules.has(declaration.specifier))
      throw new TypeError("Duplicate native addon declaration");
    const module: Record<string, (...args: readonly unknown[]) => never> = Object.create(null);
    for (const member of declaration.members) {
      if (!member || Object.hasOwn(module, member))
        throw new TypeError("Invalid native addon member");
      module[member] = (..._args) => invokeNativeAddon(declaration.specifier, member);
    }
    modules.set(declaration.specifier, Object.freeze(module));
  }
  return modules as ReadonlyMap<string, object>;
}

// #1071 can replace this call boundary once object-call escalation has an accepted contract.
function invokeNativeAddon(addon: string, member: string): never {
  throw new NodeCapabilityNeedsMachineError(addon, member);
}

