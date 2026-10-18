import * as NodeModule from "node:module";

// oxc-parser and oxc-transform load a per-platform napi binding from beside
// their own files, so the CLI bundle keeps them external
// (scripts/lib/cli-external-packages.ts). Reach them through createRequire, not
// `import`: the single-executable build can only `import` Node built-ins.
// Type imports straight from the packages are fine; they are erased.
// They load on first use, so the Runner, which only compiles when an agent
// saves an automation, starts without them.
const requireOxc = NodeModule.createRequire(import.meta.url);

type OxcParser = typeof import("oxc-parser");
type OxcTransform = typeof import("oxc-transform");
let parser: OxcParser | undefined;
let transformer: OxcTransform | undefined;
const oxcParser = () => (parser ??= requireOxc("oxc-parser") as OxcParser);
const oxcTransform = () => (transformer ??= requireOxc("oxc-transform") as OxcTransform);

export const parseSync = (...args: Parameters<OxcParser["parseSync"]>) =>
  oxcParser().parseSync(...args);
export const transformSync = (...args: Parameters<OxcTransform["transformSync"]>) =>
  oxcTransform().transformSync(...args);

/** Uses the lazy native loader so packaged CLIs need no external ES-module import. */
export const visitorKeysOf = (type: string): ReadonlyArray<string> | undefined =>
  oxcParser().visitorKeys[type];
