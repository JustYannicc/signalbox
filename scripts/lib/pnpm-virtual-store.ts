// @effect-diagnostics nodeBuiltinImport:off - Vite and Metro load this before an Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** Extra filesystem roots needed to serve packages from pnpm's external store. */
export function pnpmVirtualStoreFolders(workspaceRoot: string): string[] {
  const modulesRoot = NodePath.join(workspaceRoot, "node_modules");
  // pnpm 11 writes JSON to .modules.yaml, including a custom store's actual path.
  const manifest: unknown = JSON.parse(
    NodeFS.readFileSync(NodePath.join(modulesRoot, ".modules.yaml"), "utf8"),
  );
  const virtualStoreDir =
    typeof manifest === "object" &&
    manifest !== null &&
    "virtualStoreDir" in manifest &&
    typeof manifest.virtualStoreDir === "string"
      ? manifest.virtualStoreDir
      : ".pnpm";
  const store = NodePath.resolve(modulesRoot, virtualStoreDir);
  const relative = NodePath.relative(workspaceRoot, store);
  return relative === ".." ||
    relative.startsWith(`..${NodePath.sep}`) ||
    NodePath.isAbsolute(relative)
    ? [store]
    : [];
}

/** Vite's default workspace root plus any external package store. */
export function pnpmViteFsAllow(appRoot: string): string[] {
  const workspaceRoot = NodePath.resolve(appRoot, "../..");
  return [workspaceRoot, ...pnpmVirtualStoreFolders(workspaceRoot)];
}
