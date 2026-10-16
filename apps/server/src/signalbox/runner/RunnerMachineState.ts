import type { SkippedFolder } from "@signalbox/runner-protocol/DriveProtocol";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { DependencyTree, DependencyTreesError } from "./RunnerDependencies.ts";
import { escapeGitignore, makeExcludes, RESTORED_BLOCK, threadExcludes } from "./RunnerExcludes.ts";
import { EMPTY_TREE, type RunnerGit } from "./RunnerGit.ts";

/**
 * A thread's machine state (#490): everything on its machine that git's
 * auto-save leaves out, kept so a new machine, on any compute backend, picks
 * the thread up where the last one left it. It's a tree beside the auto-save,
 * on the thread's private `machine` ref (`DriveProtocol.ts`):
 *
 * - `checkout/`: files in the checkout the auto-save doesn't hold, mostly what
 *   git ignores (`.env`, `notes/`, local databases).
 * - `outside/<name>/`: folders of the thread's machine outside the checkout,
 *   its home and its harnesses' config, minus what the Runner writes itself
 *   or saves another way (session mirrors).
 * - `dependencies.json`: the dependency trees left out, with the install key
 *   each was at.
 * - `excludes`: the thread's own lines in `.git/info/exclude`, which ignore
 *   files the way a `.gitignore` does.
 *
 * Nothing a restore puts back may reach a save unless someone un-ignores it
 * on purpose (a secret would go to `main` and every git export): the
 * thread's excludes come back first, then every file about to be restored
 * that nothing ignores is ignored in a block of the Runner's own, and only
 * then do the files land.
 *
 * Left out, and listed for the thread's details with how they come back:
 * dependency trees `RunnerDependencies.ts` rebuilds (files edited after
 * their install are kept, and put back once a rebuild lands on the same key),
 * build output a project's tool rebuilds, caches, and repositories nested in
 * a folder, which keep their own history (a drive's shortcuts among them).
 *
 * Each part is staged in an index of its own that persists across saves, so
 * only files that changed since the last one are hashed again.
 */

export interface OutsideFolder {
  /** Its name under `outside/`. */
  readonly name: string;
  /** How the thread's details show it: `~` for the home folder. */
  readonly label: string;
  readonly dir: string;
  /** Paths the Runner writes itself, or saves another way: never kept, never listed. */
  readonly exclude: ReadonlyArray<string>;
  /** Caches in it: left out, and listed. */
  readonly caches: ReadonlyArray<string>;
}

export interface CapturedMachine {
  /** The state's tree, or null when there's nothing to keep. */
  readonly tree: string | null;
  readonly skipped: ReadonlyArray<SkippedFolder>;
}

const CHECKOUT = "checkout";
const OUTSIDE = "outside";
const MANIFEST = "dependencies.json";
const EXCLUDES = "excludes";
/** A gitignore pattern matching exactly the file at `path`. */
const exactPattern = (path: string) => `/${escapeGitignore(path)}`;
/** No ignore pattern can match a path with a line break: such a file is never restored. */
const unmatchable = (path: string) => /[\n\r]/.test(path);
/** Caches tools keep inside a dependency tree: never an edit worth keeping. */
const TREE_CACHES = [".cache", ".vite", ".vite-temp"];
/** Build output a project's own tool makes again, beside the file that says so. */
const BUILD_OUTPUTS: ReadonlyArray<{
  readonly dir: string;
  readonly marker: string;
  readonly recipe: string;
}> = [
  { dir: "target", marker: "Cargo.toml", recipe: "Build output: cargo builds it again" },
  { dir: ".next", marker: "package.json", recipe: "Build output: Next.js builds it again" },
  { dir: ".turbo", marker: "package.json", recipe: "A cache: Turborepo fills it again" },
  { dir: ".venv", marker: "uv.lock", recipe: "A Python environment: uv sync builds it again" },
  {
    dir: ".venv",
    marker: "poetry.lock",
    recipe: "A Python environment: poetry install builds it again",
  },
];
/** How deep build output is looked for: beside roots up to two folders deep, like dependencies. */
const BUILD_OUTPUT_DEPTH = 3;
const CACHE_RECIPE = "A cache: tools fill it again as they need it";
const NESTED_RECIPE = "A repository of its own: its history isn't kept here";

const Manifest = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      path: Schema.String,
      recipe: Schema.String,
      inputs: Schema.NullOr(Schema.String),
    }),
  ),
);
type Manifest = typeof Manifest.Type;
const decodeManifest = Schema.decodeUnknownOption(Manifest);
const encodeManifest = Schema.encodeSync(Manifest);

const literal = (file: string) => `:(literal)${file}`;
const excluded = (file: string) => `:(exclude,literal)${file}`;
const within = (file: string, dir: string) => file === dir || file.startsWith(`${dir}/`);
/** A path as `find -path` matches it literally. */
const findPath = (file: string) => `./${file.replace(/[*?[\]\\]/g, (c) => `\\${c}`)}`;
const nul = (paths: ReadonlyArray<string>) => paths.map((file) => `${file}\0`).join("");

export const makeMachineState = Effect.fn("makeMachineState")(function* (input: {
  /** The thread's checkout. */
  readonly cwd: string;
  readonly gitDir: string;
  readonly git: RunnerGit;
  readonly outside: ReadonlyArray<OutsideFolder>;
  /** The dependency trees the machine rebuilds (`RunnerDependencies.trees`). */
  readonly trees: Effect.Effect<ReadonlyArray<DependencyTree>, DependencyTreesError>;
  /** Paths of the checkout where a drive's shortcuts are mounted. */
  readonly shortcuts: () => ReadonlySet<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { git, gitDir } = input;
  /** Edits inside dependency trees a restore holds back until those trees are rebuilt. */
  let held: {
    readonly commit: string;
    readonly trees: Manifest;
    readonly files: ReadonlyArray<string>;
  } | null = null;
  const excludesFile = makeExcludes(fs, path, gitDir);
  /** The thread's excludes as last saved, and their blob. */
  let excludesSaved: { readonly text: string; readonly blob: string | null } | null = null;
  /** Edits inside dependency trees as last looked for. */
  let edited: ReadonlyArray<string> = [];

  /** Git run on `dir` as its work tree, with its own index. */
  const inFolder = (dir: string, args: ReadonlyArray<string>) =>
    dir === input.cwd ? args : ["-C", dir, "--git-dir", gitDir, "--work-tree", dir, ...args];

  /** Runs `find` in `dir`; answers its output, NUL-separated entries. */
  const find = (dir: string, args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make("find", [".", ...args], { cwd: dir, stdin: "ignore", stderr: "ignore" }),
      );
      const [out] = yield* Effect.all(
        [Stream.mkString(Stream.decodeText(child.stdout)), child.exitCode],
        { concurrency: "unbounded" },
      );
      return out
        .split("\0")
        .filter((entry) => entry.length > 0)
        .map((entry) => entry.replace(/^\.\//, ""));
    }).pipe(Effect.scoped);

  /** `find` tests pruning `paths` (relative to where it runs) and the folder's own `.git`. */
  const pruning = (paths: ReadonlyArray<string>) => [
    "(",
    "-path",
    "./.git",
    ...paths.flatMap((file) => ["-o", "-path", findPath(file)]),
    ")",
    "-prune",
    "-o",
  ];

  /**
   * Repositories inside `dir`, outside `skip`: git would keep only a link to
   * each (and refuses one with no commit yet), so they're left out.
   */
  const nestedRepositories = (dir: string, skip: ReadonlyArray<string>) =>
    Effect.map(find(dir, [...pruning(skip), "-name", ".git", "-print0", "-prune"]), (found) =>
      found.map((entry) => entry.slice(0, -"/.git".length)).sort(),
    );

  /**
   * Stages everything in `dir` but `skip` in `index`, plus `extra` files
   * inside skipped folders, and answers the tree. Entries for skipped paths
   * are dropped first, so a folder newly skipped leaves nothing behind.
   */
  const stage = (
    dir: string,
    index: string,
    skip: ReadonlyArray<string>,
    extra: ReadonlyArray<string>,
  ) =>
    Effect.gen(function* () {
      const env = { GIT_INDEX_FILE: index };
      if (skip.length > 0 && (yield* fs.exists(index))) {
        yield* git.run(
          inFolder(dir, [
            "rm",
            "--cached",
            "-r",
            "-q",
            "--ignore-unmatch",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
          ]),
          { env, stdin: nul(skip.map(literal)) },
        );
      }
      yield* git.run(
        inFolder(dir, ["add", "-A", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"]),
        { env, stdin: nul([".", ...skip.map(excluded)]) },
      );
      if (extra.length > 0) {
        yield* git.run(
          inFolder(dir, ["add", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"]),
          { env, stdin: nul(extra.map(literal)) },
        );
      }
      return (yield* git.run(inFolder(dir, ["write-tree"]), { env })).trim();
    });

  /** Build output in the checkout, beside the file its tool makes it from. */
  const buildOutputs = (skip: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const names = [...new Set(BUILD_OUTPUTS.map((output) => output.dir))];
      const candidates = yield* find(input.cwd, [
        "-maxdepth",
        String(BUILD_OUTPUT_DEPTH),
        ...pruning(skip),
        "-type",
        "d",
        "(",
        ...names.flatMap((name, index) => [...(index === 0 ? [] : ["-o"]), "-name", name]),
        ")",
        "-print0",
        "-prune",
      ]);
      const found: Array<SkippedFolder> = [];
      for (const candidate of candidates.sort()) {
        const name = path.basename(candidate);
        const parent = path.join(input.cwd, path.dirname(candidate));
        for (const output of BUILD_OUTPUTS.filter((entry) => entry.dir === name)) {
          if (!(yield* fs.exists(path.join(parent, output.marker)))) continue;
          found.push({ path: candidate, recipe: output.recipe });
          break;
        }
      }
      return found;
    });

  /** Files in a dependency tree written after its install finished, its tools' caches aside. */
  const editedAfterInstall = (tree: DependencyTree) =>
    Effect.gen(function* () {
      if (tree.installed === null || !(yield* fs.exists(tree.installed.record))) return [];
      if (!(yield* fs.exists(path.join(input.cwd, tree.path)))) return [];
      const record = tree.installed.record;
      const found = yield* find(path.join(input.cwd, tree.path), [
        "(",
        ...TREE_CACHES.flatMap((name, index) => [...(index === 0 ? [] : ["-o"]), "-name", name]),
        ")",
        "-prune",
        "-o",
        "-type",
        "f",
        "-newer",
        record,
        "-print0",
      ]);
      return found
        .map((file) => `${tree.path}/${file}`)
        .filter((file) => path.join(input.cwd, file) !== record);
    });

  /** The files `index` holds that tree `base` lacks, as a tree of their own; null for none. */
  const beyond = (index: string, base: string) =>
    Effect.gen(function* () {
      const raw = yield* git.run(
        ["diff-index", "--cached", "--raw", "-z", "--no-renames", "--diff-filter=A", base],
        { env: { GIT_INDEX_FILE: index } },
      );
      const fields = raw.split("\0");
      const entries: Array<string> = [];
      for (let i = 0; i + 1 < fields.length; i += 2) {
        const [, mode, , oid] = fields[i]!.split(" ");
        entries.push(`${mode} ${oid}\t${fields[i + 1]}`);
      }
      if (entries.length === 0) return null;
      const scratch = path.join(gitDir, "signalbox-machine-beyond-index");
      return yield* Effect.gen(function* () {
        const env = { GIT_INDEX_FILE: scratch };
        yield* git.run(["read-tree", "--empty"], { env });
        yield* git.run(["update-index", "-z", "--index-info"], { env, stdin: nul(entries) });
        return (yield* git.run(["write-tree"], { env })).trim();
      }).pipe(Effect.ensuring(fs.remove(scratch, { force: true }).pipe(Effect.ignore)));
    });

  const mktree = (entries: ReadonlyArray<readonly [mode: string, oid: string, name: string]>) =>
    git
      .run(["mktree", "-z"], {
        stdin: nul(
          // mktree puts entries in tree order itself.
          entries.map(
            ([mode, oid, name]) => `${mode} ${mode === "040000" ? "tree" : "blob"} ${oid}\t${name}`,
          ),
        ),
      })
      .pipe(Effect.map((out) => out.trim()));

  /**
   * The machine state beside an auto-save whose tree is `base`. Edits inside
   * dependency trees are looked for again only with `scanEdits` (a turn's
   * end): finding them stats every file of every tree.
   */
  const capture = (base: string, options: { readonly scanEdits: boolean }) =>
    Effect.gen(function* () {
      const trees = yield* input.trees;
      const skipped: Array<SkippedFolder> = trees.map((tree) => ({
        path: tree.path,
        recipe: tree.recipe,
      }));
      const treePaths = trees.map((tree) => tree.path);
      skipped.push(...(yield* buildOutputs(treePaths)));
      const shortcuts = input.shortcuts();
      const nested = yield* nestedRepositories(
        input.cwd,
        skipped.map((folder) => folder.path),
      );
      for (const repository of nested) {
        if (!shortcuts.has(repository)) skipped.push({ path: repository, recipe: NESTED_RECIPE });
      }
      edited = options.scanEdits
        ? (yield* Effect.forEach(trees, editedAfterInstall)).flat()
        : yield* Effect.filter(edited, (file) => fs.exists(path.join(input.cwd, file)));
      const index = path.join(gitDir, "signalbox-machine-index");
      yield* stage(
        input.cwd,
        index,
        [
          ...skipped.map((folder) => folder.path),
          ...nested.filter((repository) => shortcuts.has(repository)),
        ],
        edited,
      );
      const checkout = yield* beyond(index, base);

      const outside: Array<readonly [string, string, string]> = [];
      for (const folder of input.outside) {
        if (!(yield* fs.exists(folder.dir))) continue;
        const caches: Array<string> = [];
        for (const cache of folder.caches) {
          if (yield* fs.exists(path.join(folder.dir, cache))) caches.push(cache);
        }
        const inner = yield* nestedRepositories(folder.dir, [...folder.exclude, ...folder.caches]);
        for (const file of caches)
          skipped.push({ path: `${folder.label}/${file}`, recipe: CACHE_RECIPE });
        for (const file of inner)
          skipped.push({ path: `${folder.label}/${file}`, recipe: NESTED_RECIPE });
        const tree = yield* stage(
          folder.dir,
          path.join(gitDir, `signalbox-machine-${folder.name}-index`),
          [...folder.exclude, ...folder.caches, ...inner],
          [],
        );
        if (tree !== EMPTY_TREE) outside.push(["040000", tree, folder.name]);
      }

      if (checkout === null && outside.length === 0 && trees.length === 0) {
        return { tree: null, skipped } satisfies CapturedMachine;
      }
      // What ignores the checkout's files only matters with checkout files to ignore.
      const excludes = checkout === null ? "" : threadExcludes(yield* excludesFile.read).join("\n");
      if (excludes !== excludesSaved?.text) {
        excludesSaved = {
          text: excludes,
          blob:
            excludes === ""
              ? null
              : (yield* git.run(["hash-object", "-w", "--stdin"], {
                  stdin: `${excludes}\n`,
                })).trim(),
        };
      }
      const excludesBlob = excludesSaved.blob;
      const manifest = encodeManifest(
        trees.map((tree) => ({
          path: tree.path,
          recipe: tree.recipe,
          inputs: tree.installed?.inputs ?? null,
        })),
      );
      const manifestBlob = (yield* git.run(["hash-object", "-w", "--stdin"], {
        stdin: manifest,
      })).trim();
      const root = yield* mktree([
        ...(checkout === null ? [] : [["040000", checkout, CHECKOUT] as const]),
        ...(outside.length === 0 ? [] : [["040000", yield* mktree(outside), OUTSIDE] as const]),
        ["100644", manifestBlob, MANIFEST],
        ...(excludesBlob === null ? [] : [["100644", excludesBlob, EXCLUDES] as const]),
      ]);
      return { tree: root, skipped } satisfies CapturedMachine;
    });

  /** Adds the thread's saved excludes to this repository's, keeping the lines already there. */
  const restoreExcludes = (commit: string) =>
    Effect.gen(function* () {
      const saved = yield* git.exec(["show", `${commit}:${EXCLUDES}`]);
      if (saved.code === 0) yield* excludesFile.appendLines(threadExcludes(saved.stdout));
    });

  /**
   * Ignores each of `files` that nothing here ignores, in the Runner's own
   * block, before they're written: a `.gitignore` that held one may not have
   * come back with it. A `.gitignore` negating one (`!.env`) still wins,
   * which is how a thread un-ignores it on purpose.
   */
  const ignoreRestored = (files: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      // Paths need not exist to be checked; a failed check ignores them all.
      const ignored = new Set(
        files.length === 0
          ? []
          : (yield* git.exec(["check-ignore", "--no-index", "-z", "--stdin"], {
              stdin: nul(files),
            })).stdout
              .split("\0")
              .filter((file) => file.length > 0),
      );
      yield* excludesFile.replaceBlock(
        RESTORED_BLOCK,
        files.filter((file) => !ignored.has(file)).map(exactPattern),
      );
    });

  /** Whether `rev` names an object here. */
  const exists = (rev: string) =>
    git.exec(["cat-file", "-e", rev]).pipe(Effect.map((result) => result.code === 0));

  /** Writes `files` of tree `rev` into `dir`, as git would check them out. */
  const writeFiles = (dir: string, rev: string, files: ReadonlyArray<string> | "all") =>
    Effect.gen(function* () {
      if (files !== "all" && files.length === 0) return;
      const scratch = path.join(gitDir, "signalbox-machine-restore-index");
      const env = { GIT_INDEX_FILE: scratch };
      yield* Effect.gen(function* () {
        yield* git.run(["read-tree", rev], { env });
        yield* fs.makeDirectory(dir, { recursive: true });
        yield* files === "all"
          ? git.run(inFolder(dir, ["checkout-index", "-a", "-f"]), { env })
          : git.run(inFolder(dir, ["checkout-index", "-f", "-z", "--stdin"]), {
              env,
              stdin: nul(files),
            });
      }).pipe(Effect.ensuring(fs.remove(scratch, { force: true }).pipe(Effect.ignore)));
    });

  /**
   * Puts the state of `commit` back on a new machine: checkout files `target`
   * (the auto-save or branch it was checked out at) doesn't hold, and every
   * outside folder. Edits inside dependency trees wait for `restoreEdits`.
   */
  const restore = (commit: string, target: string | null) =>
    Effect.gen(function* () {
      const shown = yield* git.exec(["show", `${commit}:${MANIFEST}`]);
      const trees = Option.getOrElse(
        shown.code === 0 ? decodeManifest(shown.stdout) : Option.none(),
        (): Manifest => [],
      );
      const checkout = `${commit}:${CHECKOUT}`;
      const files = (yield* exists(checkout))
        ? (yield* git.run([
            "diff-tree",
            "-r",
            "-z",
            "--name-only",
            "--no-renames",
            "--diff-filter=A",
            target ?? EMPTY_TREE,
            checkout,
          ]))
            .split("\0")
            .filter((file) => file.length > 0)
        : [];
      const inTree = (file: string) => trees.some((tree) => within(file, tree.path));
      // What ignored these files comes back before they do, so none is ever unignored here.
      yield* restoreExcludes(commit);
      const restored = files.filter((file) => !inTree(file) && !unmatchable(file));
      yield* ignoreRestored(restored);
      yield* writeFiles(input.cwd, checkout, restored);
      const edits = files.filter(inTree);
      held = edits.length > 0 ? { commit, trees, files: edits } : null;
      for (const folder of input.outside) {
        const saved = `${commit}:${OUTSIDE}/${folder.name}`;
        if (yield* exists(saved)) yield* writeFiles(folder.dir, saved, "all");
      }
    });

  /** Puts back edits inside each dependency tree the rebuild left at the key they were made at. */
  const restoreEdits = Effect.gen(function* () {
    if (held === null) return;
    const { commit, trees: saved, files } = held;
    held = null;
    const current = yield* input.trees.pipe(Effect.orElseSucceed(() => []));
    const again = saved.filter(
      (tree) =>
        tree.inputs !== null &&
        current.some((now) => now.path === tree.path && now.installed?.inputs === tree.inputs),
    );
    yield* writeFiles(
      input.cwd,
      `${commit}:${CHECKOUT}`,
      files.filter((file) => again.some((tree) => within(file, tree.path))),
    );
  });

  return { capture, restore, restoreEdits };
});

export type MachineState = Effect.Success<ReturnType<typeof makeMachineState>>;
