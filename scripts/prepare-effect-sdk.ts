// @effect-diagnostics nodeBuiltinImport:off - Install-time setup runs before an Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const require = NodeModule.createRequire(import.meta.url);
const tscRsEntry = NodeFS.realpathSync(require.resolve("tsc-rs"));
const tscRsRequire = NodeModule.createRequire(tscRsEntry);
const tscRsPackagePath = NodeFS.realpathSync(tscRsRequire.resolve("tsc-rs/package.json"));
// oxlint-disable-next-line t3code/no-global-process-runtime -- Install setup must run before workspace runtimes are linked.
const host = { platform: process.platform, architecture: process.arch };
const { platform, architecture } = host;
const platformPackageName = `@tsc-rs/${platform}-${architecture}`;
const platformPackagePath = NodeFS.realpathSync(
  tscRsRequire.resolve(`${platformPackageName}/package.json`),
);
const tscRsPackage = JSON.parse(NodeFS.readFileSync(tscRsPackagePath, "utf8")) as {
  version: string;
};
const platformPackage = JSON.parse(NodeFS.readFileSync(platformPackagePath, "utf8")) as {
  name: string;
  version: string;
};

if (
  platformPackage.name !== platformPackageName ||
  platformPackage.version !== tscRsPackage.version
) {
  throw new Error(`The installed ${platformPackageName} package does not match tsc-rs`);
}

const compilerDirectory = NodePath.join(NodePath.dirname(platformPackagePath), "lib");
const compilerName = platform === "win32" ? "tsc.exe" : "tsc";
try {
  NodeFS.accessSync(
    NodePath.join(compilerDirectory, compilerName),
    platform === "win32" ? NodeFS.constants.F_OK : NodeFS.constants.X_OK,
  );
  NodeFS.accessSync(NodePath.join(compilerDirectory, "lib.d.ts"));
} catch {
  throw new Error(`The installed ${platformPackageName} package is missing its tsc executable`);
}

const generatedDirectory = NodeURL.fileURLToPath(new URL("../.generated", import.meta.url));
NodeFS.mkdirSync(generatedDirectory, { recursive: true });
if (NodeFS.lstatSync(generatedDirectory).isSymbolicLink()) {
  throw new Error("Expected .generated to be a worktree-local directory");
}

// The native TypeScript SDK accepts a directory containing tsc and its standard libraries.
// Keep the generated link in the worktree so one install cannot repoint another worktree.
const sdkDirectory = NodePath.join(generatedDirectory, "tsc-rs-sdk");
const existing = NodeFS.lstatSync(sdkDirectory, { throwIfNoEntry: false });
if (existing) {
  if (!existing.isSymbolicLink()) {
    throw new Error("Expected .generated/tsc-rs-sdk to be a generated link");
  }
  NodeFS.unlinkSync(sdkDirectory);
}
NodeFS.symlinkSync(compilerDirectory, sdkDirectory, "junction");
