import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";

// Codegen reads this fixture's manifest to choose lunorash/* generated imports.
const projectDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const packageDir = NodePath.resolve(projectDir, "..");
const require = NodeModule.createRequire(import.meta.url);
const bin = (name, path) =>
  NodePath.resolve(NodePath.dirname(require.resolve(`${name}/package.json`)), path);

const run = (script, args, cwd) => {
  const result = NodeChildProcess.spawnSync(process.execPath, [script, ...args], {
    cwd,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run(bin("lunorash", "dist/bin.mjs"), ["codegen"], projectDir);
run(
  bin("typescript", "bin/tsc"),
  ["--noEmit", "--project", NodePath.resolve(projectDir, "tsconfig.json")],
  packageDir,
);
