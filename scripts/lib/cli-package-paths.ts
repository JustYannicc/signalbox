import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

// Direct dependencies and pnpm's private hoist links point into either store layout.
const MODULE_ROOTS = [
  "apps/server/node_modules",
  "apps/desktop/node_modules",
  "node_modules",
  "node_modules/.pnpm/node_modules",
] as const;

export const findInstalledCliPackageDirectory = Effect.fn("findInstalledCliPackageDirectory")(
  function* (repoRoot: string, packageName: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const root of MODULE_ROOTS) {
      const candidate = path.join(repoRoot, root, packageName);
      if (yield* fs.exists(path.join(candidate, "package.json"))) {
        return yield* fs.realPath(candidate);
      }
    }
    return null;
  },
);

/** Packages reachable from this checkout, without scanning other worktrees' shared slots. */
export const readInstalledCliPackageDirectories = Effect.fn("readInstalledCliPackageDirectories")(
  function* (repoRoot: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const installed = new Map<string, string>();
    for (const root of MODULE_ROOTS) {
      const modulesDir = path.join(repoRoot, root);
      if (!(yield* fs.exists(modulesDir))) continue;
      for (const owner of yield* fs.readDirectory(modulesDir)) {
        if (owner.startsWith(".")) continue;
        const names = owner.startsWith("@")
          ? (yield* fs.readDirectory(path.join(modulesDir, owner))).map(
              (scoped) => `${owner}/${scoped}`,
            )
          : [owner];
        for (const name of names) {
          if (installed.has(name)) continue;
          const directory = yield* findInstalledCliPackageDirectory(repoRoot, name);
          if (directory !== null) installed.set(name, directory);
        }
      }
    }
    return installed;
  },
);
