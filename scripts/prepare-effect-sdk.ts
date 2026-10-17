// @effect-diagnostics nodeBuiltinImport:off - install-time setup runs before an Effect runtime exists.
import getExePath from "@effect/tsgo/lib/getExePath";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const compilerDirectory = NodePath.dirname(NodeFS.realpathSync(getExePath()));
NodeFS.accessSync(NodePath.join(compilerDirectory, "lib.d.ts"));

const generatedDirectory = NodeURL.fileURLToPath(new URL("../.generated", import.meta.url));
NodeFS.mkdirSync(generatedDirectory, { recursive: true });
if (NodeFS.lstatSync(generatedDirectory).isSymbolicLink()) {
  throw new Error(`Expected a worktree-local directory: ${generatedDirectory}`);
}

// Native VS Code's resolveTsdkPathToExe accepts a directory containing tsc.
// Link its adjacent standard libraries too, without patching pnpm's shared packages.
const sdkDirectory = NodePath.join(generatedDirectory, "effect-tsgo-sdk");
const existing = NodeFS.lstatSync(sdkDirectory, { throwIfNoEntry: false });
if (existing) {
  if (!existing.isSymbolicLink()) {
    throw new Error(`Expected a generated SDK link: ${sdkDirectory}`);
  }
  NodeFS.unlinkSync(sdkDirectory);
}
NodeFS.symlinkSync(compilerDirectory, sdkDirectory, "junction");
