import * as NodeModule from "node:module";

// oxc-parser and oxc-transform load a per-platform napi binding from beside
// their own files, so the CLI bundle keeps them external
// (scripts/lib/cli-external-packages.ts). Reach them through createRequire, not
// `import`: the single-executable build can only `import` Node built-ins.
// Type imports straight from the packages are fine; they are erased.
const requireOxc = NodeModule.createRequire(import.meta.url);

export const { parseSync, visitorKeys } = requireOxc("oxc-parser") as typeof import("oxc-parser");
export const { transformSync } = requireOxc("oxc-transform") as typeof import("oxc-transform");
