// @effect-diagnostics nodeBuiltinImport:off - install-time filesystem and compiler fixtures.
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
import getExePath from "@effect/tsgo/lib/getExePath";

import rootPackage from "../package.json" with { type: "json" };
import editorSettings from "../.vscode/settings.json" with { type: "json" };

const require = NodeModule.createRequire(import.meta.url);
const exec = NodeUtil.promisify(NodeChildProcess.exec);
const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

function scratch() {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "effect-sdk-")),
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
  NodeFS.copyFileSync(
    NodeURL.fileURLToPath(new URL("./prepare-effect-sdk.ts", import.meta.url)),
    NodePath.join(root, "scripts/prepare-effect-sdk.ts"),
  );
  write(NodePath.join(root, "package.json"), JSON.stringify(rootPackage));
  return root;
}

function sdkCompiler(worktree: string, compilerName: string) {
  // VS Code's native resolveTsdkPathToExe falls back to <tsdk>/tsc[.exe].
  // https://github.com/microsoft/typescript-go/blob/2bd066d87f5bafd315be9f40889d0a60b9e58e0b/_extension/src/util.ts
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

function stageEffectPackage(
  store: string,
  version: string,
  platformName: string,
  compilerName: string,
) {
  const effect = NodePath.join(store, `effect-tsgo-${version}`);
  const platform = NodePath.join(store, `${platformName}-${version}`);
  const artifact = NodePath.join(platform, "artifacts/typescript/7.0.2");
  write(
    NodePath.join(effect, "package.json"),
    JSON.stringify({
      name: "@effect/tsgo",
      version,
      type: "module",
      exports: { "./lib/getExePath": "./lib/getExePath.js" },
    }),
  );
  write(
    NodePath.join(effect, "lib/getExePath.js"),
    NodeFS.readFileSync(require.resolve("@effect/tsgo/lib/getExePath"), "utf8"),
  );
  write(
    NodePath.join(platform, "package.json"),
    JSON.stringify({ name: `@effect/${platformName}`, version }),
  );
  write(
    NodePath.join(platform, "lib/upstream.json"),
    JSON.stringify({
      schemaVersion: 5,
      components: { typescript: { "7.0.2": { gitHead: "fixture" } } },
    }),
  );
  write(NodePath.join(artifact, compilerName), `Effect compiler ${version}`);
  write(NodePath.join(artifact, "lib.d.ts"), `Effect standard library ${version}`);
  link(platform, NodePath.join(effect, "node_modules/@effect", platformName));
  return { effect, artifact };
}

it.effect("prepare isolates worktree SDK versions without changing shared packages", () =>
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    const architecture = yield* HostProcess.Architecture;
    const compilerName = platform === "win32" ? "tsc.exe" : "tsc";
    const platformName = `tsgo-${platform}-${architecture}`;
    yield* Effect.promise(async () => {
      const root = scratch();
      const store = NodePath.join(root, "store");
      const typescript = NodePath.join(store, "typescript");
      const native = NodePath.join(store, "typescript-platform");
      write(
        NodePath.join(typescript, "package.json"),
        JSON.stringify({
          name: "typescript",
          version: "7.0.2",
          gitHead: "fixture",
        }),
      );
      write(NodePath.join(native, "lib", compilerName), "unpatched shared TypeScript");
      write(NodePath.join(native, "lib/lib.d.ts"), "unpatched shared libraries");
      const first = stageEffectPackage(store, "0.50.0", platformName, compilerName);
      const second = stageEffectPackage(store, "0.51.1", platformName, compilerName);
      const updated = stageEffectPackage(store, "0.52.0", platformName, compilerName);
      const worktreeA = stageWorktree(NodePath.join(root, "worktree-a"));
      const worktreeB = stageWorktree(NodePath.join(root, "worktree-b"));
      for (const worktree of [worktreeA, worktreeB]) {
        link(typescript, NodePath.join(worktree, "node_modules/typescript"));
        link(
          native,
          NodePath.join(
            worktree,
            `node_modules/@typescript/typescript-${platform}-${architecture}`,
          ),
        );
      }
      link(first.effect, NodePath.join(worktreeA, "node_modules/@effect/tsgo"));
      link(second.effect, NodePath.join(worktreeB, "node_modules/@effect/tsgo"));

      // Run the actual prepare command; only Vite's unrelated config step is stubbed.
      const bin = NodePath.join(root, "bin");
      const vp = NodePath.join(bin, platform === "win32" ? "vp.cmd" : "vp");
      write(vp, platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
      NodeFS.chmodSync(vp, 0o755);
      const env = { ...process.env, PATH: `${bin}${NodePath.delimiter}${process.env.PATH ?? ""}` };
      const prepare = (cwd: string) => exec(rootPackage.scripts.prepare, { cwd, env });
      const before = snapshot(store);
      await Promise.all([prepare(worktreeA), prepare(worktreeB)]);
      await prepare(worktreeA);

      expect(NodeFS.realpathSync(sdkCompiler(worktreeA, compilerName))).toBe(
        NodePath.join(first.artifact, compilerName),
      );
      expect(NodeFS.realpathSync(sdkCompiler(worktreeB, compilerName))).toBe(
        NodePath.join(second.artifact, compilerName),
      );
      expect(NodeFS.readFileSync(sdkCompiler(worktreeA, compilerName), "utf8")).toBe(
        "Effect compiler 0.50.0",
      );
      expect(NodeFS.readFileSync(sdkCompiler(worktreeB, compilerName), "utf8")).toBe(
        "Effect compiler 0.51.1",
      );

      NodeFS.unlinkSync(NodePath.join(worktreeA, "node_modules/@effect/tsgo"));
      link(updated.effect, NodePath.join(worktreeA, "node_modules/@effect/tsgo"));
      await prepare(worktreeA);
      expect(NodeFS.realpathSync(sdkCompiler(worktreeA, compilerName))).toBe(
        NodePath.join(updated.artifact, compilerName),
      );
      expect(NodeFS.realpathSync(sdkCompiler(worktreeB, compilerName))).toBe(
        NodePath.join(second.artifact, compilerName),
      );
      expect(
        NodeFS.readFileSync(
          NodePath.join(worktreeA, editorSettings["js/ts.tsdk.path"], "lib.d.ts"),
          "utf8",
        ),
      ).toBe("Effect standard library 0.52.0");
      expect(snapshot(store)).toEqual(before);

      const mismatched = NodePath.join(root, "mismatched-typescript");
      write(
        NodePath.join(mismatched, "package.json"),
        JSON.stringify({
          name: "typescript",
          version: "7.0.2",
          gitHead: "not-supported",
        }),
      );
      NodeFS.unlinkSync(NodePath.join(worktreeA, "node_modules/typescript"));
      link(mismatched, NodePath.join(worktreeA, "node_modules/typescript"));
      await expect(prepare(worktreeA)).rejects.toThrow(
        "No packaged Effect TypeScript executable matches installed TypeScript",
      );
      expect(NodeFS.realpathSync(sdkCompiler(worktreeA, compilerName))).toBe(
        NodePath.join(updated.artifact, compilerName),
      );
      expect(NodeFS.realpathSync(sdkCompiler(worktreeB, compilerName))).toBe(
        NodePath.join(second.artifact, compilerName),
      );
      expect(snapshot(store)).toEqual(before);
    });
  }),
);

it.effect("generated SDK runs the installed Effect binary with its standard libraries", () =>
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    const compilerName = platform === "win32" ? "tsc.exe" : "tsc";
    yield* Effect.promise(async () => {
      const worktree = stageWorktree(scratch());
      link(
        NodePath.dirname(require.resolve("@effect/tsgo/package.json")),
        NodePath.join(worktree, "node_modules/@effect/tsgo"),
      );
      link(
        NodePath.dirname(require.resolve("typescript/package.json")),
        NodePath.join(worktree, "node_modules/typescript"),
      );
      await execFile(process.execPath, ["scripts/prepare-effect-sdk.ts"], { cwd: worktree });
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
        NodeFS.realpathSync(getExePath()),
      );
    });
  }),
);
