// @effect-diagnostics nodeBuiltinImport:off - Knip resolves declaration companions on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { Preprocessor } from "knip";

const preprocess: Preprocessor = (options) => {
  const unusedFiles = new Set(Object.keys(options.issues.files));
  for (const file of unusedFiles) {
    if (!file.endsWith(".d.mts")) continue;
    const implementation = `${file.slice(0, -6)}.mjs`;
    if (unusedFiles.has(implementation)) continue;
    const source = NodeFS.statSync(NodePath.resolve(options.cwd, implementation), {
      throwIfNoEntry: false,
    });
    if (!source?.isFile()) continue;
    // TypeScript resolves this companion without an explicit import from the .mjs.
    delete options.issues.files[file];
    options.counters.files--;
  }
  return options;
};

export default preprocess;
