// @effect-diagnostics nodeBuiltinImport:off - writes only prepared modules supplied by an isolated facet cache.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type {
  NodeGeneratedCode,
  NodeGeneratedCodeModuleMap,
} from "../../src/isolate/NodeGeneratedCode.ts";

/** Materializes the facet cache's budgeted map for a caller-owned next-boot proof. */
export async function prepareGeneratedCodeModules(
  destination: string,
  generatedCode: Pick<NodeGeneratedCode, "prepare">,
  moduleMapByteBudget: number,
): Promise<NodeGeneratedCodeModuleMap> {
  const prepared = await generatedCode.prepare(moduleMapByteBudget);
  const root = NodePath.resolve(destination);
  const entries = Object.entries(prepared.modules);
  for (const [name] of entries) {
    if (!/^gen\/[0-9a-f]{64}\.js$/u.test(name)) {
      throw new Error(`Generated-code cache returned an invalid next-boot module name: ${name}`);
    }
  }
  await NodeFSP.mkdir(root, { recursive: true });
  await NodeFSP.rm(NodePath.join(root, "gen"), { recursive: true, force: true });
  for (const [name, source] of entries) {
    const target = NodePath.resolve(root, name);
    const relative = NodePath.relative(root, target);
    if (relative.startsWith("..") || NodePath.isAbsolute(relative)) {
      throw new Error(`Generated-code module escaped the proof destination: ${name}`);
    }
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    await NodeFSP.writeFile(target, source);
  }
  await NodeFSP.writeFile(
    NodePath.join(root, "generated-modules.json"),
    JSON.stringify(
      {
        moduleMapByteBudget,
        moduleMapBytes: prepared.moduleMapBytes,
        modules: Object.keys(prepared.modules).sort(),
        omittedKeys: prepared.omittedKeys,
      },
      null,
      2,
    ),
  );
  await NodeFSP.writeFile(
    NodePath.join(root, "generated-function-index.json"),
    JSON.stringify(prepared.functionIndex, null, 2),
  );
  return prepared;
}
