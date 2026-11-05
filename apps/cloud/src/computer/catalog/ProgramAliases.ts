import type { ComputerCatalogProgram } from "./ChildProgramFactory.ts";
import { childProgramPaths } from "../ChildProgramPaths.ts";

export function registerProgramAliases(bindings: Map<string, ComputerCatalogProgram>) {
  // Newly added aliases must not become inputs to this registration pass.
  const programs = Array.from(bindings);
  const aliases = new Set<string>();
  for (const [executable, binding] of programs) {
    for (const alias of childProgramPaths(executable)) {
      if (bindings.has(alias)) continue;
      bindings.set(
        alias,
        Object.freeze({
          ...binding,
          executable: alias,
          manifest: Object.freeze({
            ...binding.manifest,
            name: `${binding.manifest.name}:path:${alias}`,
          }),
        }),
      );
      aliases.add(alias);
    }
  }
  return aliases;
}
