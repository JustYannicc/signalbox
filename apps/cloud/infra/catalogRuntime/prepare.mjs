import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

const require = NodeModule.createRequire(import.meta.url);
const cli = NodePath.join(
  NodePath.dirname(require.resolve("lunorash/package.json")),
  "dist/bin.mjs",
);
const result = NodeChildProcess.spawnSync(process.execPath, [cli, "codegen", "--lazy-functions"], {
  cwd: NodePath.resolve(import.meta.dirname, "../../src/catalog"),
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
