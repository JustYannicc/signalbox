// @effect-diagnostics nodeBuiltinImport:off - Filesystem and compiler fixtures exercise install setup.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { afterEach, expect } from "vite-plus/test";

import editorSettings from "../.vscode/settings.json" with { type: "json" };

const require = NodeModule.createRequire(import.meta.url);
const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

function scratch() {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tsc-rs-sdk-")),
  );
  roots.push(root);
  return root;
}

function write(path: string, content: string) {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, content);
}

function link(target: string, path: string) {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.symlinkSync(target, path, "junction");
}

function stageWorktree(root: string) {
  NodeFS.mkdirSync(NodePath.join(root, "scripts"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(root, ".vscode"), { recursive: true });
  write(NodePath.join(root, "package.json"), JSON.stringify({ type: "module" }));
  NodeFS.copyFileSync(
    NodeURL.fileURLToPath(new URL("./prepare-effect-sdk.ts", import.meta.url)),
    NodePath.join(root, "scripts/prepare-effect-sdk.ts"),
  );
  write(NodePath.join(root, ".vscode/settings.json"), JSON.stringify(editorSettings));
  return root;
}

function sdkCompiler(worktree: string, compilerName: string) {
  return NodePath.join(worktree, editorSettings["js/ts.tsdk.path"], compilerName);
}

function snapshot(directory: string): unknown {
  return NodeFS.readdirSync(directory)
    .sort()
    .map((name) => {
      const path = NodePath.join(directory, name);
      const stat = NodeFS.lstatSync(path);
      return [
        name,
        stat.isSymbolicLink()
          ? NodeFS.readlinkSync(path)
          : stat.isDirectory()
            ? snapshot(path)
            : NodeFS.readFileSync(path).toString("base64"),
      ];
    });
}

function stageTscRsPackage(
  store: string,
  build: string,
  platformPackageName: string,
  compilerName: string,
  options: { includeCompiler?: boolean } = {},
) {
  const tscRs = NodePath.join(store, `tsc-rs-${build}`);
  const platform = NodePath.join(store, `${platformPackageName.replaceAll("/", "-")}-${build}`);
  const library = NodePath.join(platform, "lib");
  write(
    NodePath.join(tscRs, "package.json"),
    JSON.stringify({
      name: "tsc-rs",
      version: "0.7.0",
      type: "module",
      main: "lib/version.cjs",
      exports: { ".": "./lib/version.cjs", "./package.json": "./package.json" },
    }),
  );
  write(NodePath.join(tscRs, "lib/version.cjs"), "exports.version = '7.1.0-dev';\n");
  write(
    NodePath.join(platform, "package.json"),
    JSON.stringify({
      name: platformPackageName,
      version: "0.7.0",
      type: "module",
      exports: { "./package.json": "./package.json" },
    }),
  );
  if (options.includeCompiler !== false) {
    const compiler = NodePath.join(library, compilerName);
    write(compiler, `Rust compiler ${build}`);
    NodeFS.chmodSync(compiler, 0o755);
  }
  write(NodePath.join(library, "lib.d.ts"), `Rust standard library ${build}`);
  link(platform, NodePath.join(tscRs, "node_modules", platformPackageName));
  return { tscRs, library };
}

it.effect("prepare isolates worktree SDKs without changing shared Rust packages", () =>
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    const architecture = yield* HostProcess.Architecture;
    const nodeExecutable = yield* HostProcess.ExecutablePath;
    const compilerName = platform === "win32" ? "tsc.exe" : "tsc";
    const platformPackageName = `@tsc-rs/${platform}-${architecture}`;
    yield* Effect.promise(async () => {
      const root = scratch();
      const store = NodePath.join(root, "store");
      NodeFS.mkdirSync(store);
      const first = stageTscRsPackage(store, "first", platformPackageName, compilerName);
      const second = stageTscRsPackage(store, "second", platformPackageName, compilerName);
      const updated = stageTscRsPackage(store, "updated", platformPackageName, compilerName);
      const missing = stageTscRsPackage(store, "missing", platformPackageName, compilerName, {
        includeCompiler: false,
      });
      const worktreeA = stageWorktree(NodePath.join(root, "worktree-a"));
      const worktreeB = stageWorktree(NodePath.join(root, "worktree-b"));
      for (const worktree of [worktreeA, worktreeB]) {
        NodeFS.mkdirSync(NodePath.join(worktree, "node_modules"), { recursive: true });
      }
      link(first.tscRs, NodePath.join(worktreeA, "node_modules/tsc-rs"));
      link(second.tscRs, NodePath.join(worktreeB, "node_modules/tsc-rs"));

      // Run the actual generator from independent worktrees, including a repeat install.
      const prepare = (cwd: string) =>
        execFile(nodeExecutable, ["scripts/prepare-effect-sdk.ts"], { cwd });
      const before = snapshot(store);
      await Promise.all([prepare(worktreeA), prepare(worktreeB)]);
      await prepare(worktreeA);

      expect(NodeFS.realpathSync(sdkCompiler(worktreeA, compilerName))).toBe(
        NodePath.join(first.library, compilerName),
      );
      expect(NodeFS.realpathSync(sdkCompiler(worktreeB, compilerName))).toBe(
        NodePath.join(second.library, compilerName),
      );
      expect(NodeFS.readFileSync(sdkCompiler(worktreeA, compilerName), "utf8")).toBe(
        "Rust compiler first",
      );
      expect(NodeFS.readFileSync(sdkCompiler(worktreeB, compilerName), "utf8")).toBe(
        "Rust compiler second",
      );

      NodeFS.unlinkSync(NodePath.join(worktreeA, "node_modules/tsc-rs"));
      link(updated.tscRs, NodePath.join(worktreeA, "node_modules/tsc-rs"));
      await prepare(worktreeA);
      expect(NodeFS.realpathSync(sdkCompiler(worktreeA, compilerName))).toBe(
        NodePath.join(updated.library, compilerName),
      );
      expect(NodeFS.realpathSync(sdkCompiler(worktreeB, compilerName))).toBe(
        NodePath.join(second.library, compilerName),
      );
      expect(
        NodeFS.readFileSync(
          NodePath.join(worktreeA, editorSettings["js/ts.tsdk.path"], "lib.d.ts"),
          "utf8",
        ),
      ).toBe("Rust standard library updated");
      expect(snapshot(store)).toEqual(before);

      NodeFS.unlinkSync(NodePath.join(worktreeA, "node_modules/tsc-rs"));
      link(missing.tscRs, NodePath.join(worktreeA, "node_modules/tsc-rs"));
      await expect(prepare(worktreeA)).rejects.toThrow("missing its tsc executable");
      expect(NodeFS.realpathSync(sdkCompiler(worktreeA, compilerName))).toBe(
        NodePath.join(updated.library, compilerName),
      );
      expect(NodeFS.realpathSync(sdkCompiler(worktreeB, compilerName))).toBe(
        NodePath.join(second.library, compilerName),
      );
      expect(snapshot(store)).toEqual(before);
    });
  }),
);

it.effect("generated SDK runs the installed Rust compiler with its standard libraries", () =>
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    const architecture = yield* HostProcess.Architecture;
    const nodeExecutable = yield* HostProcess.ExecutablePath;
    const compilerName = platform === "win32" ? "tsc.exe" : "tsc";
    const tscRsEntry = NodeFS.realpathSync(require.resolve("tsc-rs"));
    const tscRsRequire = NodeModule.createRequire(tscRsEntry);
    const platformPackageName = `@tsc-rs/${platform}-${architecture}`;
    const platformPackagePath = NodeFS.realpathSync(
      tscRsRequire.resolve(`${platformPackageName}/package.json`),
    );
    const installedLibrary = NodePath.join(NodePath.dirname(platformPackagePath), "lib");
    yield* Effect.promise(async () => {
      const worktree = stageWorktree(scratch());
      link(
        NodePath.dirname(NodeFS.realpathSync(require.resolve("tsc-rs/package.json"))),
        NodePath.join(worktree, "node_modules/tsc-rs"),
      );
      await execFile(nodeExecutable, ["scripts/prepare-effect-sdk.ts"], { cwd: worktree });
      write(
        NodePath.join(worktree, "valid.ts"),
        "const value: Promise<number> = Promise.resolve(1);\n",
      );
      const result = await execFile(
        sdkCompiler(worktree, compilerName),
        ["--noEmit", "--target", "esnext", "valid.ts"],
        { cwd: worktree },
      );
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(NodeFS.realpathSync(sdkCompiler(worktree, compilerName))).toBe(
        NodePath.join(installedLibrary, compilerName),
      );
    });
  }),
);
