import type { KernelProgramRegistry } from "../../kernel/KernelAbi.ts";
import type { KernelProgramBinding } from "../../kernel/KernelProgramHost.ts";
import { childProgramPaths } from "../ChildProgramPaths.ts";

export function registerProgramAliases(
  registry: KernelProgramRegistry,
  bindings: Map<string, KernelProgramBinding>,
) {
  // New aliases must not become independent program registrations during this pass.
  const programs = [...bindings];
  const aliases = new Set<string>();
  for (const [executable, binding] of programs) {
    for (const alias of childProgramPaths(executable)) {
      if (bindings.has(alias)) continue;
      // The kernel gives each manifest version one executable identity.
      const manifest = Object.freeze({
        ...binding.manifest,
        name: `${binding.manifest.name}:path:${alias}`,
      });
      const result = registry.register(manifest);
      if (result.status !== "ok") throw new Error(`Could not register ${manifest.name}`);
      bindings.set(alias, { manifest, implementation: binding.implementation });
      aliases.add(alias);
    }
  }
  return aliases;
}
