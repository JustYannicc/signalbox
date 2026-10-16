import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

/**
 * The Runner's lines in a checkout's `.git/info/exclude`, beside the ones the
 * thread's agent adds there itself. The Runner writes a line that keeps
 * dependency trees off the branch, and blocks between a begin and an end
 * marker that it rewrites whole. Everything else is the thread's own, and its
 * machine state keeps it (`RunnerMachineState.ts`).
 */

export interface ExcludeBlock {
  readonly begin: string;
  readonly end: string;
}

/** Never saved to a drive, whatever its own ignore files say: rebuilt from lockfiles (`RunnerDependencies.ts`). */
export const CACHES_LINE = "node_modules/";

/** Where the drive's shortcuts are mounted (`RunnerShortcuts.ts`). */
export const SHORTCUTS_BLOCK: ExcludeBlock = {
  begin: "# signalbox: shortcuts, mounted from other drives",
  end: "# signalbox: end of shortcuts",
};

/** Files a new machine got back from the machine state that nothing else ignores (`RunnerMachineState.ts`). */
export const RESTORED_BLOCK: ExcludeBlock = {
  begin: "# signalbox: restored machine state, never saved",
  end: "# signalbox: end of restored machine state",
};

const RUNNER_BLOCKS = [SHORTCUTS_BLOCK, RESTORED_BLOCK];

/** `path` escaped for a gitignore pattern, matched literally. */
export const escapeGitignore = (path: string) => path.replace(/[\\*?[\]!# \t]/g, (c) => `\\${c}`);

/** `text` without `block`: its begin line through its own end line, when both are there. */
const withoutBlock = (text: string, block: ExcludeBlock) => {
  const begin = text.indexOf(block.begin);
  if (begin === -1) return text;
  const end = text.indexOf(block.end, begin);
  if (end === -1) return text;
  return text.slice(0, begin) + text.slice(end + block.end.length).replace(/^\n/, "");
};

/** The thread's own lines of a `.git/info/exclude`: not the Runner's, and not git's comments. */
export const threadExcludes = (text: string) =>
  RUNNER_BLOCKS.reduce(withoutBlock, text)
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#") && line !== CACHES_LINE);

/** A checkout's `.git/info/exclude`, read and written as the Runner does. */
export const makeExcludes = (fs: FileSystem.FileSystem, path: Path.Path, gitDir: string) => {
  const file = path.join(gitDir, "info", "exclude");
  const read = fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
  const write = (current: string, next: string) =>
    next === current
      ? Effect.void
      : fs
          .makeDirectory(path.dirname(file), { recursive: true })
          .pipe(Effect.andThen(fs.writeFileString(file, next)));
  const joined = (kept: string, added: string) =>
    kept.length > 0 && !kept.endsWith("\n") && added.length > 0
      ? `${kept}\n${added}`
      : kept + added;
  return {
    read,
    /** Adds each of `lines` not there yet, keeping everything else. */
    appendLines: (lines: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const current = yield* read;
        const present = new Set(current.split("\n"));
        const missing = [...new Set(lines)].filter((line) => !present.has(line));
        yield* write(
          current,
          joined(current, missing.length === 0 ? "" : `${missing.join("\n")}\n`),
        );
      }),
    /** Replaces `block` with `patterns`, or removes it when there are none. */
    replaceBlock: (block: ExcludeBlock, patterns: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const current = yield* read;
        const lines =
          patterns.length === 0 ? "" : [block.begin, ...patterns, block.end, ""].join("\n");
        yield* write(current, joined(withoutBlock(current, block), lines));
      }),
  };
};
