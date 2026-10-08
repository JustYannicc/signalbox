import type { DriveFileChange } from "@signalbox/runner-protocol/DriveProtocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

/**
 * The Runner's own git, in one repository. It sees none of the host's or the
 * agent's git setup: no global or system config, no hooks, no prompts, and no
 * `GIT_*` variable from the Runner's environment (a stray `GIT_DIR` would
 * point every command at another repository).
 */

export class RunnerGitError extends Schema.TaggedError<RunnerGitError>()("RunnerGitError", {
  message: Schema.String,
}) {}

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface GitRunOptions {
  readonly stdin?: string;
  readonly env?: Record<string, string>;
}

/** The empty tree's id, the base of a branch that had no commit yet. */
export { EMPTY_TREE } from "@signalbox/runner-protocol/DriveProtocol";

const INHERITED = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "USER"];

export const makeRunnerGit = Effect.fn("makeRunnerGit")(function* (cwd: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const env: Record<string, string> = {};
  for (const name of INHERITED) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  });

  /** Runs git, answering its output whatever its exit code. */
  const exec = (args: ReadonlyArray<string>, options: GitRunOptions = {}) =>
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make("git", ["-c", "core.hooksPath=/dev/null", ...args], {
          cwd,
          env: { ...env, ...options.env },
          extendEnv: false,
          stdin:
            options.stdin === undefined ? "ignore" : Stream.encodeText(Stream.make(options.stdin)),
        }),
      );
      const [stdout, stderr, code] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(child.stdout)),
          Stream.mkString(Stream.decodeText(child.stderr)),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return { stdout, stderr, code: Number(code) } satisfies GitResult;
    }).pipe(
      Effect.scoped,
      Effect.mapError(
        (cause) =>
          new RunnerGitError({ message: `git ${args[0]} could not run: ${cause.message}` }),
      ),
    );

  /** Runs git and fails unless it exits 0; answers stdout. */
  const run = (args: ReadonlyArray<string>, options?: GitRunOptions) =>
    exec(args, options).pipe(
      Effect.flatMap((result) =>
        result.code === 0
          ? Effect.succeed(result.stdout)
          : Effect.fail(
              new RunnerGitError({
                message: `git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim()}`,
              }),
            ),
      ),
    );

  /** A rev's id, or null when it does not exist. */
  const resolve = (rev: string) =>
    exec(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]).pipe(
      Effect.map((result) => (result.code === 0 ? result.stdout.trim() : null)),
    );

  const isAncestor = (ancestor: string, descendant: string) =>
    exec(["merge-base", "--is-ancestor", ancestor, descendant]).pipe(
      Effect.flatMap((result) =>
        result.code === 0
          ? Effect.succeed(true)
          : result.code === 1
            ? Effect.succeed(false)
            : Effect.fail(new RunnerGitError({ message: `merge-base: ${result.stderr.trim()}` })),
      ),
    );

  /** Points `ref` at `oid`, or deletes it for null. */
  const setRef = (ref: string, oid: string | null) =>
    oid === null
      ? exec(["update-ref", "-d", ref]).pipe(Effect.asVoid)
      : run(["update-ref", ref, oid]).pipe(Effect.asVoid);

  const lines = (text: string) => text.split("\n").filter((line) => line.length > 0);

  /** What `head` changed since `base` (a commit or tree), renames detected; binary files count 0/0. */
  const changedFiles = (base: string, head: string) =>
    Effect.gen(function* () {
      const kinds = new Map<string, DriveFileChange["kind"]>();
      const status = (yield* run(["diff", "--name-status", "-M", "-z", base, head])).split("\0");
      for (let i = 0; i < status.length - 1;) {
        const code = status[i]!.charAt(0);
        const renamed = code === "R" || code === "C";
        const file = status[renamed ? i + 2 : i + 1]!;
        kinds.set(file, KINDS[code] ?? "modified");
        i += renamed ? 3 : 2;
      }
      const files: Array<DriveFileChange> = [];
      const counts = (yield* run(["diff", "--numstat", "-M", "-z", base, head])).split("\0");
      for (let i = 0; i < counts.length - 1;) {
        const [additions = "-", deletions = "-", inline = ""] = counts[i]!.split("\t");
        const file = inline === "" ? counts[i + 2]! : inline;
        i += inline === "" ? 3 : 1;
        files.push({
          path: file,
          kind: kinds.get(file) ?? "modified",
          additions: additions === "-" ? 0 : Number(additions),
          deletions: deletions === "-" ? 0 : Number(deletions),
        });
      }
      return files;
    });

  return { exec, run, resolve, isAncestor, setRef, lines, changedFiles };
});

const KINDS: Record<string, DriveFileChange["kind"]> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "added",
  T: "modified",
};

export type RunnerGit = Effect.Success<ReturnType<typeof makeRunnerGit>>;
