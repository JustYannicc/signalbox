// @effect-diagnostics nodeBuiltinImport:off - Native Node runs only in disposable filesystem fixtures.
import * as NodeChildProcess from "node:child_process";
import type * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { nodeFsGlobOracleFixture } from "./helpers/NodeFsGlobOracleFixture.ts";

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function globApi(glob: unknown) {
  if (typeof glob !== "function") throw new Error("Expected a glob function");
  return glob as (pattern: unknown, options?: unknown) => AsyncIterableIterator<unknown>;
}

function direntSummary(value: unknown, root: string): string {
  if (typeof value !== "object" || value === null) throw new Error("Expected a Dirent");
  const entry = value as NodeFS.Dirent<string>;
  if (typeof entry.parentPath !== "string") throw new Error("Expected Dirent.parentPath");
  const parent = NodePath.relative(root, entry.parentPath) || ".";
  const kind = entry.isFile()
    ? "file"
    : entry.isDirectory()
      ? "directory"
      : entry.isSymbolicLink()
        ? "symlink"
        : "other";
  const path = parent === "." ? String(entry.name) : `${parent}/${String(entry.name)}`;
  return `${path}:${kind}`;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

describe("Node fs/promises glob differential behavior", () => {
  it("matches Node for braces, classes, extglobs, dotfiles, arrays, and exclusions", async () => {
    const fixture = await nodeFsGlobOracleFixture();
    const kernelGlob = globApi(fixture.promises.glob);
    const nativeGlob = globApi(NodeFSP.glob);
    try {
      const patterns: Array<string | readonly string[]> = [
        "src/**/*.{js,ts}",
        "src/[ab].@(js|ts)",
        "src/*",
        "src/.*",
        ["**/*.js", "src/a.js", "**/*.js"],
      ];
      for (const pattern of patterns) {
        const kernel = await collect(kernelGlob(pattern, { cwd: "/work" }));
        const native = await collect(nativeGlob(pattern, { cwd: fixture.nativeRoot }));
        expect(kernel.toSorted()).toEqual(native.toSorted());
      }

      const kernelPatternExclusions = await collect(
        kernelGlob("**/*.js", {
          cwd: "/work",
          exclude: ["**/node_modules/**", "docs/**"],
        }),
      );
      const nativePatternExclusions = await collect(
        nativeGlob("**/*.js", {
          cwd: fixture.nativeRoot,
          exclude: ["**/node_modules/**", "docs/**"],
        }),
      );
      expect(kernelPatternExclusions.toSorted()).toEqual(nativePatternExclusions.toSorted());
      expect(kernelPatternExclusions.toSorted()).toEqual([
        "src/a.js",
        "src/a.test.js",
        "src/deep/c.js",
      ]);

      const kernelExcludeValues: string[] = [];
      const nativeExcludeValues: string[] = [];
      const kernelCallbackExclusions = await collect(
        kernelGlob("**/*.js", {
          cwd: "/work",
          exclude: (value: unknown) => {
            if (typeof value !== "string") throw new Error("Expected a string exclusion value");
            kernelExcludeValues.push(value);
            return value === "node_modules" || value === "docs";
          },
        }),
      );
      const nativeCallbackExclusions = await collect(
        nativeGlob("**/*.js", {
          cwd: fixture.nativeRoot,
          exclude: (value: unknown) => {
            if (typeof value !== "string") throw new Error("Expected a string exclusion value");
            nativeExcludeValues.push(value);
            return value === "node_modules" || value === "docs";
          },
        }),
      );
      expect(kernelCallbackExclusions.toSorted()).toEqual(nativeCallbackExclusions.toSorted());
      expect(kernelExcludeValues.toSorted()).toEqual(nativeExcludeValues.toSorted());

      const kernelDirentExclusions: string[] = [];
      const nativeDirentExclusions: string[] = [];
      const kernelDirents = await collect(
        kernelGlob("**/*", {
          cwd: "/work",
          withFileTypes: true,
          exclude: (value: unknown) => {
            if (typeof value === "string") throw new Error("Expected a Dirent exclusion value");
            const entry = value as NodeFS.Dirent<string>;
            kernelDirentExclusions.push(String(entry.name));
            return entry.name === "node_modules";
          },
        }),
      );
      const nativeDirents = await collect(
        nativeGlob("**/*", {
          cwd: fixture.nativeRoot,
          withFileTypes: true,
          exclude: (value: unknown) => {
            if (typeof value === "string") throw new Error("Expected a Dirent exclusion value");
            const entry = value as NodeFS.Dirent<string>;
            nativeDirentExclusions.push(String(entry.name));
            return entry.name === "node_modules";
          },
        }),
      );
      expect(kernelDirentExclusions).toContain("node_modules");
      expect(nativeDirentExclusions).toContain("node_modules");
      expect(kernelDirents.map((entry) => direntSummary(entry, "/work")).toSorted()).toEqual(
        nativeDirents.map((entry) => direntSummary(entry, fixture.nativeRoot)).toSorted(),
      );
      expect(kernelDirents.map((entry) => direntSummary(entry, "/work"))).toContain(
        "src/a.js:file",
      );
      expect(kernelDirents.map((entry) => direntSummary(entry, "/work"))).toContain(
        "src:directory",
      );
    } finally {
      await fixture.close();
    }
  });

  it("resolves string and URL cwd values against the kernel filesystem", async () => {
    const fixture = await nodeFsGlobOracleFixture();
    const kernelGlob = globApi(fixture.promises.glob);
    const nativeGlob = globApi(NodeFSP.glob);
    try {
      const kernelStringCwd = await collect(kernelGlob("*.js", { cwd: "/work/src" }));
      const nativeStringCwd = await collect(
        nativeGlob("*.js", { cwd: NodePath.join(fixture.nativeRoot, "src") }),
      );
      expect(kernelStringCwd.toSorted()).toEqual(nativeStringCwd.toSorted());

      const kernelUrlCwd = await collect(kernelGlob("*.js", { cwd: new URL("file:///work/src/") }));
      const nativeUrlCwd = await collect(
        nativeGlob("*.js", {
          cwd: NodeURL.pathToFileURL(NodePath.join(fixture.nativeRoot, "src")),
        }),
      );
      expect(kernelUrlCwd.toSorted()).toEqual(nativeUrlCwd.toSorted());

      fixture.kernelFs.chdir("/work");
      const pending = kernelGlob("*.js");
      fixture.kernelFs.chdir("/work/src");
      const kernelChangingCwd = await collect(pending);
      const nativeChangingCwd = await collect(
        nativeGlob("*.js", { cwd: NodePath.join(fixture.nativeRoot, "src") }),
      );
      expect(kernelChangingCwd.toSorted()).toEqual(nativeChangingCwd.toSorted());
    } finally {
      await fixture.close();
    }
  });

  it("matches symlink traversal, cycles, and truthy withFileTypes behavior", async () => {
    const fixture = await nodeFsGlobOracleFixture();
    const kernelGlob = globApi(fixture.promises.glob);
    const nativeGlob = globApi(NodeFSP.glob);
    try {
      for (const options of [{}, { followSymlinks: true }]) {
        const kernel = await collect(kernelGlob("**/*.ts", { cwd: "/work", ...options }));
        const native = await collect(
          nativeGlob("**/*.ts", { cwd: fixture.nativeRoot, ...options }),
        );
        expect(kernel.toSorted()).toEqual(native.toSorted());
      }

      const kernel = await collect(kernelGlob("*.js", { cwd: "/work/src", withFileTypes: "yes" }));
      const native = await collect(
        nativeGlob("*.js", {
          cwd: NodePath.join(fixture.nativeRoot, "src"),
          withFileTypes: "yes",
        }),
      );
      expect(kernel.map((entry) => direntSummary(entry, "/work/src")).toSorted()).toEqual(
        native
          .map((entry) => direntSummary(entry, NodePath.join(fixture.nativeRoot, "src")))
          .toSorted(),
      );
    } finally {
      await fixture.close();
    }
  });

  it("matches Node option and pattern validation during iteration", async () => {
    const fixture = await nodeFsGlobOracleFixture();
    const kernelGlob = globApi(fixture.promises.glob);
    const nativeGlob = globApi(NodeFSP.glob);
    try {
      const invalidCalls: Array<[unknown, unknown]> = [
        [42, {}],
        [["*.js", 42], {}],
        ["*", null],
        ["*", 42],
        ["*", true],
        ["*", []],
        ["*", () => undefined],
        ["*", { cwd: 42 }],
        ["*", { followSymlinks: "yes" }],
        ["*", { exclude: 42 }],
      ];
      for (const [pattern, options] of invalidCalls) {
        const kernelError = await rejectionCode(() => kernelGlob(pattern, options));
        const nativeError = await rejectionCode(() => nativeGlob(pattern, options));
        expect(kernelError).toEqual(nativeError);
      }
      const [kernelArrayMessage, nativeArrayMessage] = await Promise.all([
        rejectionMessage(() => kernelGlob("missing", [])),
        rejectionMessage(() => nativeGlob("missing", [])),
      ]);
      expect(kernelArrayMessage).toEqual(nativeArrayMessage);
    } finally {
      await fixture.close();
    }
  });

  it("resolves absolute cwd without reading a removed current directory", async () => {
    const fixture = await nodeFsGlobOracleFixture();
    try {
      await fixture.promises.mkdir("/gone");
      fixture.kernelFs.chdir("/gone");
      fixture.kernelFs.rmdir("/gone");
      const native = NodeChildProcess.execFileSync(
        NodeProcess.execPath,
        [
          "--input-type=module",
          "--eval",
          `import {glob,mkdir,rmdir} from 'node:fs/promises';
const root=process.argv[1];
await mkdir(root+'/gone');
process.chdir(root+'/gone');
await rmdir(root+'/gone');
const matches=[];
for await(const match of glob('*.js',{cwd:root+'/src',exclude:[]}))matches.push(match);
const missing=[];
for await(const match of glob('no-match',{cwd:root+'/src'}))missing.push(match);
process.stdout.write(JSON.stringify({matches:matches.toSorted(),missing}));`,
          fixture.nativeRoot,
        ],
        { encoding: "utf8" },
      );
      const glob = globApi(fixture.promises.glob);
      const missing = await collect(glob("no-match", { cwd: "/work/src" }));
      expect(
        JSON.stringify({
          matches: (await collect(glob("*.js", { cwd: "/work/src", exclude: [] }))).toSorted(),
          missing,
        }),
      ).toEqual(native);
      expect(
        JSON.stringify({
          matches: (
            await collect(glob("*.js", { cwd: new URL("file:///work/src/"), exclude: [] }))
          ).toSorted(),
          missing,
        }),
      ).toEqual(native);
    } finally {
      await fixture.close();
    }
  });

  it("keeps generated wrappers byte-identical to the pinned source recipe", () => {
    const generator = NodeURL.fileURLToPath(
      new URL("../node/fs/generate-glob-wrappers.mjs", import.meta.url),
    );
    NodeChildProcess.execFileSync(NodeProcess.execPath, [generator, "--check"], {
      stdio: "pipe",
    });
  });
});

async function rejectionCode(iterable: () => AsyncIterable<unknown>): Promise<string | undefined> {
  try {
    await collect(iterable());
    return undefined;
  } catch (error) {
    return errorCode(error);
  }
}

async function rejectionMessage(iterable: () => AsyncIterable<unknown>): Promise<string> {
  try {
    await collect(iterable());
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected glob options to be rejected");
}
