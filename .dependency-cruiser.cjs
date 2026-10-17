// Workspace exports and fork/upstream severity are applied to this graph by lint:boundaries.
const CLOUD = "apps/cloud/src";
const INTERNALS = `^${CLOUD}/[^/]+/[^/]+/`;
const TESTS = "(?:^|/)(?:tests?|__tests__)/|\\.(?:test|spec)\\.[cm]?[jt]sx?$";

module.exports = {
  forbidden: [
    {
      name: "cloud-entrypoints",
      comment: "Other modules use root files; subfolders are private implementation.",
      severity: "warn",
      from: { pathNot: `^${CLOUD}/[^/]+/` },
      to: { path: INTERNALS },
    },
    {
      name: "cloud-entrypoints-across-modules",
      severity: "warn",
      from: { path: `^${CLOUD}/([^/]+)/` },
      to: { path: INTERNALS, pathNot: `^${CLOUD}/$1/` },
    },
    {
      name: "tests-through-entrypoints",
      comment: "Tests may use root entry points and fixtures, including their own tests folder.",
      severity: "warn",
      from: { path: TESTS },
      to: { path: INTERNALS, pathNot: TESTS },
    },
    {
      name: "tests-folder-is-private",
      severity: "warn",
      from: { pathNot: TESTS },
      to: {
        path: [`^${CLOUD}/[^/]+/(?:tests?|__tests__)/`, `^${CLOUD}/[^/]+/.*/(?:tests?|__tests__)/`],
      },
    },
  ],
  options: {
    // lint:boundaries checks complete cyclic edges rather than deduplicated cycle summaries.
    skipAnalysisNotInRules: true,
    doNotFollow: { path: "(?:^|/)node_modules/" },
    tsPreCompilationDeps: true,
    parser: "tsc",
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["types", "import", "node", "default"],
      extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"],
    },
  },
};
