import { type DriveShortcut, EMPTY_TREE } from "@signalbox/runner-protocol/DriveProtocol";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { DriveClient } from "./RunnerDriveClient.ts";
import { storePacks } from "./RunnerDriveMirror.ts";
import { makeRunnerGit, type RunnerGit } from "./RunnerGit.ts";

/**
 * A drive's shortcuts on its thread's machine (#142). Each shortcut shows
 * another drive at a path of the thread's checkout, so the agent works with
 * it like a folder, but it keeps that drive's own access and history:
 *
 * - It is mounted as a repository of its own, checked out at the target's
 *   latest version (`git log` there is that drive's history). A target backed
 *   by a remote repository is fetched from the remote first, one commit deep,
 *   with the turn's remote token; its drive's copy is the fallback.
 * - It is read-only: a thread only ever writes its own drive, so its files
 *   and folders lose their write bits. Each turn start brings it up to date.
 * - The drive's own repository never holds it: its path is excluded, and
 *   files the thread's branch still tracks there (a folder split out to be
 *   shared after the thread changed it) are untracked, so they never land on
 *   `main` again. They stay in the thread's history.
 *
 * Shortcuts the user can't open anymore, or that were removed, are taken down
 * at the next turn start. `.git/signalbox-shortcuts.json` remembers what is
 * mounted where, including mounts that failed to update, so none is ever left
 * behind for the drive's repository to pick up. Paths reach git literally,
 * never as patterns, and nothing is mounted below a symbolic link.
 */

export interface MountedShortcut {
  /** Relative to the thread's working directory. */
  readonly path: string;
  readonly target: string;
  /** The mount's absolute path. */
  readonly dir: string;
}

export interface ShortcutMounts {
  readonly mounted: ReadonlyArray<MountedShortcut>;
  /** What the thread should hear about, such as files no longer saved under a shortcut. */
  readonly notices: ReadonlyArray<string>;
}

const STATE_FILE = "signalbox-shortcuts.json";
/** In a mount's `.git`: the drive it shows. */
const TARGET_FILE = "signalbox-target";
/** In a mount's `.git`: the highest pack sequence of the target it holds. */
const PACKS_FILE = "signalbox-packs-seq";
const REMOTE_REF = "refs/shortcut/remote";
const EXCLUDE_BEGIN = "# signalbox: shortcuts, mounted from other drives";
const EXCLUDE_END = "# signalbox: end of shortcuts";
/** `STATE_FILE`: each mounted path, and the drive it shows. */
const MountState = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const decodeState = Schema.decodeEffect(MountState);
const encodeState = Schema.encodeEffect(MountState);

const MOUNT_CONFIG = [
  ["gc.auto", "0"],
  ["core.quotepath", "false"],
] as const;

/** Paths the cloud already checked, checked again: a mount never leaves the working directory by name. */
const isSafePath = (path: string) =>
  path.length > 0 &&
  path
    .split("/")
    .every(
      (segment) => segment !== "" && segment !== "." && segment !== ".." && segment !== ".git",
    );

/** A gitignore pattern matching exactly the folder at `path`. */
const excludePattern = (path: string) => `/${path.replace(/[\\*?[\]!#]/g, (c) => `\\${c}`)}/`;

const parentsOf = (file: string) => {
  const parents: Array<string> = [];
  for (let at = file.lastIndexOf("/"); at > 0; at = file.lastIndexOf("/", at - 1)) {
    parents.push(file.slice(0, at));
  }
  return parents;
};

export const makeRunnerShortcuts = Effect.fn("makeRunnerShortcuts")(function* (input: {
  /** The thread's working directory: a checkout of its drive. */
  readonly cwd: string;
  /** The drive's own repository. */
  readonly git: RunnerGit;
  readonly client: DriveClient;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const services = yield* Effect.context<
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  >();
  const { git, client, cwd } = input;
  const gitDir = path.join(cwd, ".git");
  const stateFile = path.join(gitDir, STATE_FILE);

  const dirOf = (relative: string) => path.join(cwd, ...relative.split("/"));
  const gitOf = (dir: string) => makeRunnerGit(dir).pipe(Effect.provide(services));

  /** What the last turn mounted, path to target. */
  const readState = fs.readFileString(stateFile).pipe(
    Effect.flatMap((text) => decodeState(text)),
    Effect.orElseSucceed((): Readonly<Record<string, string>> => ({})),
  );

  /** The target a mount shows, or null when `dir` is not one of ours. */
  const mountedTarget = (dir: string) =>
    fs.readFileString(path.join(dir, ".git", TARGET_FILE)).pipe(
      Effect.map((text) => text.trim()),
      Effect.orElseSucceed(() => null),
    );

  const isLink = (file: string) =>
    fs.readLink(file).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  /** Whether any folder between the working directory and `relative` is a link, which a mount must not follow. */
  const underLink = (relative: string) =>
    Effect.gen(function* () {
      const segments = relative.split("/");
      for (let depth = 1; depth <= segments.length; depth++) {
        if (yield* isLink(path.join(cwd, ...segments.slice(0, depth)))) return true;
      }
      return false;
    });

  /** Tracked files of a mount, with their modes. */
  const trackedEntries = (mount: RunnerGit) =>
    Effect.map(mount.run(["ls-files", "-s", "-z"]), (out) =>
      out
        .split("\0")
        .filter((line) => line.length > 0)
        .map((line) => {
          const tab = line.indexOf("\t");
          return { mode: line.slice(0, line.indexOf(" ")), file: line.slice(tab + 1) };
        }),
    );

  const trackedDirs = (entries: ReadonlyArray<{ readonly file: string }>) =>
    new Set(entries.flatMap((entry) => parentsOf(entry.file)));

  /** Lets git change the mount: its folders get their write bit back. */
  const unlock = (dir: string, mount: RunnerGit) =>
    Effect.gen(function* () {
      const entries = yield* trackedEntries(mount).pipe(Effect.orElseSucceed(() => []));
      yield* fs.chmod(dir, 0o755);
      yield* Effect.forEach(
        trackedDirs(entries),
        (folder) => fs.chmod(path.join(dir, folder), 0o755).pipe(Effect.ignore),
        { concurrency: 32, discard: true },
      );
    });

  /** Takes every write bit off the mount's files and folders. Links are left alone. */
  const lock = (dir: string, mount: RunnerGit) =>
    Effect.gen(function* () {
      const entries = yield* trackedEntries(mount);
      yield* Effect.forEach(
        entries.filter((entry) => entry.mode !== "120000" && entry.mode !== "160000"),
        (entry) =>
          fs
            .chmod(path.join(dir, entry.file), entry.mode === "100755" ? 0o555 : 0o444)
            .pipe(Effect.ignore),
        { concurrency: 32, discard: true },
      );
      yield* Effect.forEach(
        trackedDirs(entries),
        (folder) => fs.chmod(path.join(dir, folder), 0o555).pipe(Effect.ignore),
        { concurrency: 32, discard: true },
      );
      yield* fs.chmod(dir, 0o555);
    });

  /** Gives every folder under `dir` its write bit back, whatever the index says. Links are left alone. */
  const forceWritable = (dir: string) =>
    Effect.gen(function* () {
      yield* fs.chmod(dir, 0o755);
      for (const entry of yield* fs.readDirectory(dir, { recursive: true })) {
        const file = path.join(dir, entry);
        if (yield* isLink(file)) continue;
        const info = yield* fs.stat(file);
        if (info.type === "Directory") yield* fs.chmod(file, 0o755);
      }
    });

  /** Removes whatever is at `dir`, a mount of ours or leftover files, and folders it leaves empty. */
  const wipe = (dir: string) =>
    Effect.gen(function* () {
      if (!(yield* fs.exists(dir))) return;
      if (yield* isLink(dir)) {
        yield* fs.remove(dir);
      } else {
        if ((yield* mountedTarget(dir)) !== null) {
          yield* unlock(dir, yield* gitOf(dir)).pipe(Effect.ignore);
        }
        yield* fs
          .remove(dir, { recursive: true })
          .pipe(
            Effect.catch(() =>
              forceWritable(dir).pipe(Effect.andThen(fs.remove(dir, { recursive: true }))),
            ),
          );
      }
      for (let parent = path.dirname(dir); parent.startsWith(`${cwd}${path.sep}`);) {
        if ((yield* fs.readDirectory(parent)).length > 0) break;
        yield* fs.remove(parent, { recursive: true });
        parent = path.dirname(parent);
      }
    });

  /** Keeps every shortcut out of the drive's own repository. */
  const exclude = (paths: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const file = path.join(gitDir, "info", "exclude");
      const current = (yield* fs.exists(file)) ? yield* fs.readFileString(file) : "";
      const begin = current.indexOf(EXCLUDE_BEGIN);
      const end = current.indexOf(EXCLUDE_END);
      const kept =
        begin === -1 || end === -1
          ? current
          : current.slice(0, begin) + current.slice(end + EXCLUDE_END.length).replace(/^\n/, "");
      const block =
        paths.length === 0
          ? ""
          : [EXCLUDE_BEGIN, ...paths.map(excludePattern), EXCLUDE_END, ""].join("\n");
      const next = kept.length > 0 && !kept.endsWith("\n") ? `${kept}\n${block}` : kept + block;
      if (next === current) return;
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, next);
    });

  /** Stops the drive's index tracking anything under `paths`; answers the paths that had files. */
  const untrack = (paths: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      if (paths.length === 0) return [];
      // Literal: a folder named `*` must never match every file of the drive.
      const tracked = (yield* git.run(["--literal-pathspecs", "ls-files", "-z", "--", ...paths]))
        .split("\0")
        .filter((file) => file.length > 0);
      if (tracked.length === 0) return [];
      yield* git.run([
        "--literal-pathspecs",
        "rm",
        "-r",
        "-q",
        "--cached",
        "--ignore-unmatch",
        "--",
        ...paths,
      ]);
      return paths.filter((candidate) =>
        tracked.some((file) => file === candidate || file.startsWith(`${candidate}/`)),
      );
    });

  /** The commit to show: a remote-backed target's head, else its drive's `main` from its packs. */
  const commitFor = (
    dir: string,
    mount: RunnerGit,
    shortcut: DriveShortcut,
    remoteToken: string | null,
  ) =>
    Effect.gen(function* () {
      if (shortcut.remote !== null && remoteToken !== null) {
        const fetched = yield* mount.fetchHead(
          client.shortcutRemoteUrl(shortcut.target),
          REMOTE_REF,
          remoteToken,
        );
        if (fetched._tag === "fetched") return fetched.head;
        yield* Effect.logWarning("fetching a shortcut's remote failed; using its drive's copy", {
          path: shortcut.path,
          reason: fetched.reason,
        });
      }
      if (shortcut.main === null) return null;
      const mountGitDir = path.join(dir, ".git");
      const seq = yield* storePacks({
        gitDir: mountGitDir,
        git: mount,
        packs: shortcut.packs,
        shallow: shortcut.shallow,
        download: (name, packDir) => client.downloadShortcutPack(shortcut.target, name, packDir),
      }).pipe(Effect.provide(services));
      if (seq !== null) yield* fs.writeFileString(path.join(mountGitDir, PACKS_FILE), String(seq));
      return shortcut.main;
    });

  /** Mounts one readable shortcut at its latest version; answers whether it shows, and a notice. */
  const mountOne = (shortcut: DriveShortcut, remoteToken: string | null) =>
    Effect.gen(function* () {
      const dir = dirOf(shortcut.path);
      if (yield* underLink(shortcut.path)) {
        return {
          shown: false,
          notice: `${shortcut.path} can't be shown: a link in this drive is in its way.`,
        };
      }
      const ours = (yield* mountedTarget(dir)) === shortcut.target;
      if (!ours) {
        yield* wipe(dir);
        yield* fs.makeDirectory(dir, { recursive: true });
      }
      const mount = yield* gitOf(dir);
      if (!ours) {
        yield* mount.run(["init", "-q"]);
        for (const [key, value] of MOUNT_CONFIG) yield* mount.run(["config", key, value]);
        yield* fs.writeFileString(path.join(dir, ".git", TARGET_FILE), shortcut.target);
      }
      const commit = yield* commitFor(dir, mount, shortcut, remoteToken);
      // Already showing it: nothing in a read-only mount changed since.
      if (ours && commit !== null && (yield* mount.resolve("HEAD")) === commit) {
        return { shown: true, notice: null };
      }
      yield* unlock(dir, mount);
      yield* Effect.gen(function* () {
        if (commit === null) {
          yield* mount.run(["read-tree", "-u", "--reset", EMPTY_TREE]);
        } else {
          yield* mount.run(["checkout", "-q", "-f", "--detach", commit]);
        }
        yield* mount.run(["clean", "-ffdq"]);
      }).pipe(Effect.ensuring(lock(dir, mount).pipe(Effect.ignore)));
      return {
        shown: true,
        notice:
          commit === null
            ? `${shortcut.path} is empty for now: the drive it shows has no files yet.`
            : null,
      };
    });

  /**
   * The packs each target's mounts already hold, so the listing only names
   * newer ones. A target with a path not yet mounted for it holds none there.
   */
  const packsHeld = (
    state: Readonly<Record<string, string>>,
    paths?: ReadonlyArray<DriveShortcut>,
  ) =>
    Effect.gen(function* () {
      const have: Record<string, number> = {};
      for (const [relative, target] of Object.entries(state)) {
        const dir = dirOf(relative);
        if ((yield* mountedTarget(dir)) !== target) continue;
        const seq = yield* fs.readFileString(path.join(dir, ".git", PACKS_FILE)).pipe(
          Effect.map((text) => Number(text.trim())),
          Effect.orElseSucceed(() => 0),
        );
        have[target] = Math.min(have[target] ?? Infinity, Number.isSafeInteger(seq) ? seq : 0);
      }
      for (const shortcut of paths ?? []) {
        if (state[shortcut.path] !== shortcut.target) have[shortcut.target] = 0;
      }
      return have;
    });

  /** The drive's shortcuts, with every pack a new mount of a target needs. */
  const listShortcuts = (state: Readonly<Record<string, string>>) =>
    Effect.gen(function* () {
      const listed = yield* client.shortcuts(yield* packsHeld(state));
      // A target newly mounted at another path needs its packs from the start.
      const fresh = listed.filter(
        (shortcut) => shortcut.readable && state[shortcut.path] !== shortcut.target,
      );
      if (fresh.length === 0 || Object.keys(state).length === 0) return listed;
      if (!fresh.some((shortcut) => Object.values(state).includes(shortcut.target))) return listed;
      return yield* client.shortcuts(yield* packsHeld(state, fresh));
    });

  /**
   * Brings every shortcut up to date at turn start, after the drive's own
   * checkout. When the cloud can't list them, the mounts stay as they were.
   */
  const mount = (remoteToken: string | null) =>
    Effect.gen(function* () {
      const state = yield* readState;
      const previous = Object.entries(state).map(([relative, target]) => ({
        path: relative,
        target,
        dir: dirOf(relative),
      }));
      const listed = yield* listShortcuts(state).pipe(Effect.result);
      if (listed._tag === "Failure") {
        yield* Effect.logWarning(
          "listing the drive's shortcuts failed; keeping the last mounts",
          Cause.pretty(Cause.fail(listed.failure)),
        );
        return { mounted: previous, notices: [] } satisfies ShortcutMounts;
      }
      const shortcuts = listed.success.filter((shortcut) => isSafePath(shortcut.path));
      const readable = shortcuts.filter((shortcut) => shortcut.readable);
      const notices: Array<string> = [];
      for (const old of previous) {
        const kept = readable.some(
          (shortcut) => shortcut.path === old.path && shortcut.target === old.target,
        );
        if (kept) continue;
        yield* wipe(old.dir);
        if (shortcuts.some((shortcut) => shortcut.path === old.path && !shortcut.readable)) {
          notices.push(
            `${old.path} is gone from this thread: you can't open the drive it showed anymore.`,
          );
        }
      }
      const paths = shortcuts.map((shortcut) => shortcut.path);
      yield* exclude(paths);
      for (const untracked of yield* untrack(paths)) {
        notices.push(
          `Files under ${untracked} aren't saved in this drive anymore: ${untracked} shows another drive now. This thread's history keeps them.`,
        );
      }
      // Nothing of the drive's own stays behind a shortcut nobody can show.
      for (const shortcut of shortcuts) {
        if (!shortcut.readable) yield* wipe(dirOf(shortcut.path));
      }
      // Paths never overlap (the cloud refuses that), so mounts don't touch each other.
      const results = yield* Effect.forEach(
        readable,
        (shortcut) =>
          mountOne(shortcut, remoteToken).pipe(
            Effect.result,
            Effect.map((result) => ({ shortcut, result })),
          ),
        { concurrency: 4 },
      );
      const mounted: Array<MountedShortcut> = [];
      for (const { shortcut, result } of results) {
        const entry = { path: shortcut.path, target: shortcut.target, dir: dirOf(shortcut.path) };
        if (result._tag === "Failure") {
          yield* Effect.logWarning("mounting a shortcut failed", {
            path: shortcut.path,
            cause: Cause.pretty(Cause.fail(result.failure)),
          });
          notices.push(`${shortcut.path} couldn't be brought up to date this turn.`);
          continue;
        }
        if (result.success.notice !== null) notices.push(result.success.notice);
        if (result.success.shown) mounted.push(entry);
      }
      // Every readable shortcut is remembered, mounted or not, so a failed one is still taken down later.
      yield* fs.writeFileString(
        stateFile,
        // Strings to strings always encode.
        yield* Effect.orDie(
          encodeState(
            Object.fromEntries(readable.map((shortcut) => [shortcut.path, shortcut.target])),
          ),
        ),
      );
      return { mounted, notices } satisfies ShortcutMounts;
    });

  /** Lets the drive's own checkout write where mounts are, in case its branch still has files there. */
  const release = Effect.gen(function* () {
    for (const [relative, target] of Object.entries(yield* readState)) {
      const dir = dirOf(relative);
      if ((yield* mountedTarget(dir)) === target) {
        yield* unlock(dir, yield* gitOf(dir)).pipe(Effect.ignore);
      }
    }
  });

  return { mount, release };
});

export type RunnerShortcuts = Effect.Success<ReturnType<typeof makeRunnerShortcuts>>;
