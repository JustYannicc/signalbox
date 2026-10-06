/**
 * Measures a project's on-disk footprint for `workload.project.sampled`: the
 * git directory, the dependency and build caches, the rest of the working
 * tree, and which lockfiles it has. Sizes come from `du`, so this runs on
 * macOS and Linux only.
 *
 * @module projectSample
 */
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ProcessRunner from "../../../processRunner.ts";

/** Directories that hold installed dependencies or build output, not source. */
const CACHE_DIRECTORIES = [
  "node_modules",
  "target",
  ".venv",
  "venv",
  ".next",
  ".nuxt",
  ".turbo",
  ".svelte-kit",
  ".parcel-cache",
  ".gradle",
  ".build",
  "Pods",
  "DerivedData",
  ".cache",
] as const;

const LOCKFILES: Readonly<Record<string, string>> = {
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "bun.lock": "bun",
  "bun.lockb": "bun",
  "deno.lock": "deno",
  "Cargo.lock": "cargo",
  "uv.lock": "uv",
  "poetry.lock": "poetry",
  "Pipfile.lock": "pipenv",
  "go.sum": "go",
  "Gemfile.lock": "bundler",
  "composer.lock": "composer",
  "Podfile.lock": "cocoapods",
  "Package.resolved": "swiftpm",
  "mix.lock": "mix",
  "pubspec.lock": "pub",
  "gradle.lockfile": "gradle",
};

export interface ProjectSample {
  readonly gitBytes: number | undefined;
  readonly workingTreeBytes: number | undefined;
  readonly dependencyCacheBytes: number | undefined;
  readonly lockfiles: ReadonlyArray<string>;
}

const MAX_CACHE_DIRECTORIES = 2_000;
const MEASURE_TIMEOUT = "5 minutes";

/** `du -sk` lines (`<KiB>\t<path>`) as bytes per path. */
function parseDuOutput(stdout: string): ReadonlyMap<string, number> {
  const sizes = new Map<string, number>();
  for (const line of stdout.split("\n")) {
    const match = /^(\d+)\s+(.+)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      sizes.set(match[2], Number(match[1]) * 1024);
    }
  }
  return sizes;
}

export const sampleProject = Effect.fn("projectSample.sampleProject")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcessPlatform;

  const lockfiles = yield* Effect.forEach(Object.entries(LOCKFILES), ([file, kind]) =>
    fs.exists(path.join(root, file)).pipe(
      Effect.map((exists) => (exists ? [kind] : [])),
      Effect.orElseSucceed(() => []),
    ),
  );
  const sample: ProjectSample = {
    gitBytes: undefined,
    workingTreeBytes: undefined,
    dependencyCacheBytes: undefined,
    lockfiles: [...new Set(lockfiles.flat())].toSorted(),
  };
  if (platform !== "darwin" && platform !== "linux") return sample;
  // A project rooted at home (or above) would walk every personal folder,
  // and on macOS trip privacy prompts for Desktop, Documents and Downloads.
  const home = yield* Config.String("HOME").pipe(Config.withDefault(""));
  if (home !== "" && !path.relative(path.resolve(root), home).startsWith("..")) return sample;

  const run = (command: string, args: ReadonlyArray<string>) =>
    runner
      .run({
        command,
        args,
        cwd: root,
        timeout: MEASURE_TIMEOUT,
        outputMode: "truncate",
      })
      .pipe(
        Effect.map((output) => output.stdout),
        Effect.orElseSucceed(() => ""),
      );

  // Pruned at the first match, so nested caches are counted once.
  const nameTests = CACHE_DIRECTORIES.flatMap((name, index) =>
    index === 0 ? ["-name", name] : ["-o", "-name", name],
  );
  const caches = (yield* run("find", [
    root,
    "-xdev",
    "-mindepth",
    "1",
    "(",
    "-name",
    ".git",
    "-prune",
    ")",
    "-o",
    "(",
    "-type",
    "d",
    "(",
    ...nameTests,
    ")",
    "-prune",
    "-print",
    ")",
  ]))
    .split("\n")
    .filter((line) => line.length > 0)
    .slice(0, MAX_CACHE_DIRECTORIES);
  const gitDirectory = path.join(root, ".git");
  const hasGitDirectory = yield* fs.stat(gitDirectory).pipe(
    Effect.map((info) => info.type === "Directory"),
    Effect.orElseSucceed(() => false),
  );

  // Two runs: one `du` counts a path inside an earlier argument only once,
  // and implementations differ in how they report it.
  const total = parseDuOutput(yield* run("du", ["-skx", root])).get(root);
  const parts = [...(hasGitDirectory ? [gitDirectory] : []), ...caches];
  const partSizes =
    parts.length === 0 ? new Map() : parseDuOutput(yield* run("du", ["-skx", ...parts]));
  const gitBytes = hasGitDirectory ? partSizes.get(gitDirectory) : undefined;
  const cacheSizes = caches.map((cache) => partSizes.get(cache));
  const dependencyCacheBytes = cacheSizes.every((size) => size !== undefined)
    ? cacheSizes.reduce<number>((sum, size) => sum + (size ?? 0), 0)
    : undefined;

  return {
    ...sample,
    gitBytes,
    dependencyCacheBytes,
    workingTreeBytes:
      total === undefined || dependencyCacheBytes === undefined
        ? undefined
        : Math.max(0, total - (gitBytes ?? 0) - dependencyCacheBytes),
  };
});
