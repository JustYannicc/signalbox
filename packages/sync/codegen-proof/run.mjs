import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";

// Codegen reads this fixture's manifest to choose lunorash/* generated imports.
const projectDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const packageDir = NodePath.resolve(projectDir, "..");

const run = (command, args, cwd) => {
  const result = NodeChildProcess.spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run("lunora", ["codegen"], projectDir);
run("tsc", ["--noEmit", "--project", NodePath.resolve(projectDir, "tsconfig.json")], packageDir);
