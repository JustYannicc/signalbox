// @effect-diagnostics nodeBuiltinImport:off - the build entry resolves local config and renames its single emitted Node artifact.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { build, defineConfig } from "vite-plus/pack";

const packageRoot = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const isNodeBuiltin = (id: string) =>
  id.startsWith("node:") || NodeModule.builtinModules.includes(id);

const runnerCommandConfig = defineConfig({
  root: packageRoot,
  entry: { "command-runner": "src/signalbox/runner/command-main.ts" },
  format: "esm",
  platform: "node",
  outDir: "dist/command-runner",
  clean: true,
  deps: {
    alwaysBundle: (id: string) => !isNodeBuiltin(id),
    neverBundle: isNodeBuiltin,
    onlyBundle: false,
  },
});

export default runnerCommandConfig;

const isEntrypoint =
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url);

if (isEntrypoint) {
  await build({ config: false, ...runnerCommandConfig });
  const outputDirectory = NodePath.join(packageRoot, "dist/command-runner");
  const outputFiles = NodeFS.readdirSync(outputDirectory).filter((file) => /\.m?js$/.test(file));
  if (outputFiles.length !== 1) throw new Error("Expected one bundled command Runner entry.");
  const outputFile = NodePath.join(outputDirectory, outputFiles[0]!);
  const expectedFile = NodePath.join(outputDirectory, "command-runner.mjs");
  if (outputFile !== expectedFile) NodeFS.renameSync(outputFile, expectedFile);
}
