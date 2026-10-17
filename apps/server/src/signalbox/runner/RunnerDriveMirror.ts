import {
  type DriveState,
  MAX_REMOTE_COMMITS,
  type CheckpointViews,
  type ThreadRefName,
} from "@signalbox/runner-protocol/DriveProtocol";
import type { PullOperation, PullResult } from "@signalbox/runner-protocol/PullProtocol";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { type DriveClient, type DriveClientError, DriveRefusedError } from "./RunnerDriveClient.ts";
import type { RunnerGit } from "./RunnerGit.ts";

/**
 * What the local repository knows of its drive, and how objects and refs move
 * between them. `refs/drive/{main,thread,wip}` mirror the drive's refs as
 * last seen, and only ever name commits the drive has, so a pack of what a
 * commit reaches `^` those refs is closed: everything it points at is in the
 * pack or already in the drive.
 *
 * A remote-backed drive holds the remote's commits one deep: its `main` is
 * the remote's head, and a thread's branch may sit on other remote commits
 * (a newer main it rebased onto, commits pulled from its own branch on the
 * remote, #394), each kept without its parents. A pack carries such commits
 * and their folders, never their files (#406): the remote has those, and the
 * drive records them as promised. The repository here is a blobless clone of
 * the remote's whole history with the cloud's fetch proxy as its promisor, so
 * git fetches a file when it needs one; the drive's packs are promisor packs.
 * It packs through the drive's view: `DRIVE_SHALLOW` lists the drive's
 * shallow commits, and git reads it as the shallow file, so a pack never
 * walks history the drive doesn't hold.
 */

const REF_ATTEMPTS = 3;
/** The drive's shallow commits, as `.git/shallow` would list them; the repository's own may list fewer. */
const DRIVE_SHALLOW = "signalbox-drive-shallow";

/** Adds `oids` to the list in `file`, one per line, keeping what is there. Answers the ones it added. */
const appendLines = (file: string, oids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const current = (yield* fs.exists(file)) ? yield* fs.readFileString(file) : "";
    const listed = new Set(current.split("\n").filter((line) => line.length > 0));
    const missing = [...new Set(oids)].filter((oid) => !listed.has(oid));
    if (missing.length > 0) yield* fs.writeFileString(file, [...listed, ...missing, ""].join("\n"));
    return missing;
  });

/**
 * Puts a drive's `packs` into the repository at `gitDir` with `download`,
 * records its `shallow` commits, and indexes every pack. Answers
 * the highest pack sequence stored, or null when there were none. A
 * remote-backed drive's packs are `promisor` packs: what they leave out, the
 * remote has.
 */
export const storePacks = Effect.fn("storePacks")(function* (input: {
  readonly gitDir: string;
  readonly git: RunnerGit;
  readonly packs: DriveState["packs"];
  readonly shallow: DriveState["shallow"];
  readonly promisor: boolean;
  readonly download: (name: string, packDir: string) => Effect.Effect<void, DriveClientError>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packDir = path.join(input.gitDir, "objects", "pack");
  yield* Effect.forEach(input.packs, (pack) => input.download(pack.name, packDir), {
    concurrency: 8,
    discard: true,
  });
  if (input.promisor) {
    yield* Effect.forEach(
      input.packs,
      (pack) => fs.writeFileString(path.join(packDir, `pack-${pack.name}.promisor`), ""),
      { discard: true },
    );
  }
  if (input.shallow.length > 0) {
    // A drive client answers every shallow commit the drive has, every turn; only the
    // ones new to this repository need their parents checked (earlier ones already were).
    const added = yield* appendLines(path.join(input.gitDir, DRIVE_SHALLOW), input.shallow);
    // Commits whose parents aren't here either, so git never looks for them. With the
    // remote's history fetched first there are none: listing one would hide its history.
    const parents = yield* Effect.forEach(added, (oid) =>
      Effect.map(input.git.run(["cat-file", "commit", oid]), (text) => ({
        oid,
        parents: input.git
          .lines(text.slice(0, text.indexOf("\n\n")))
          .filter((line) => line.startsWith("parent "))
          .map((line) => line.slice("parent ".length)),
      })),
    );
    // One at a time: `rev-list --missing=print` never fetches (a partial clone would ask the
    // remote for each), and before git 2.44 it fails outright on a missing start.
    const absent = new Set<string>();
    for (const oid of new Set(parents.flatMap((commit) => commit.parents))) {
      const found = yield* input.git.exec(["rev-list", "--no-walk", "--missing=print", oid]);
      if (found.code !== 0) absent.add(oid);
    }
    yield* appendLines(
      path.join(input.gitDir, "shallow"),
      parents
        .filter((commit) => commit.parents.some((parent) => absent.has(parent)))
        .map((commit) => commit.oid),
    );
  }
  if (input.packs.length === 0) return null;
  // One index over every pack, so lookups stay fast as auto-saves pile packs up.
  yield* input.git.run(["multi-pack-index", "write"]);
  return Math.max(...input.packs.map((pack) => pack.seq));
});

export type DriveRefs = Readonly<Record<"main" | ThreadRefName, string | null>> & {
  readonly notes: string | null;
  readonly pinnedViews: CheckpointViews | null;
  readonly revision: string | null;
};

export const CHECKPOINT_NOTES_REF = "refs/notes/signalbox/checkpoints";

export const makeDriveMirror = Effect.fn("makeDriveMirror")(function* (input: {
  readonly gitDir: string;
  readonly git: RunnerGit;
  readonly client: DriveClient;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { git, client, gitDir } = input;
  const packDir = path.join(gitDir, "objects", "pack");
  let known: DriveRefs = {
    main: null,
    thread: null,
    wip: null,
    machine: null,
    notes: null,
    pinnedViews: null,
    revision: null,
  };
  let knownNotes: string | null = null;
  /** Whether the drive is backed by a remote, as last seen. */
  let remoteBacked = false;
  /** Whether the cloud keeps machine state (#490): only then is a pack ever private. */
  let keepsMachine = false;

  /** Fetches the drive's packs we lack, then mirrors its refs. */
  const adopt = (state: DriveState) =>
    Effect.gen(function* () {
      const seq = yield* storePacks({
        gitDir,
        git,
        packs: state.packs,
        shallow: state.shallow,
        promisor: state.remote !== null,
        download: client.downloadPack,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      if (seq !== null) client.havePacksThrough(seq);
      const refs = { ...state, machine: state.machine ?? null };
      for (const ref of ["main", "thread", "wip", "machine"] as const) {
        yield* git.setRef(`refs/drive/${ref}`, refs[ref]);
      }
      if (state.notes !== undefined) {
        knownNotes = state.notes;
        yield* git.setRef(CHECKPOINT_NOTES_REF, state.notes);
      }
      known = {
        main: state.main,
        thread: state.thread,
        wip: state.wip,
        machine: state.machine ?? null,
        notes: state.notes ?? knownNotes,
        pinnedViews: state.pinnedViews ?? null,
        revision: state.revision ?? null,
      };
      remoteBacked = state.remote !== null;
      keepsMachine = state.machine !== undefined;
    });

  const driveShallow = path.join(gitDir, DRIVE_SHALLOW);

  /**
   * Remote commits `commit` builds on that the drive lacks: where its new
   * commits meet the remote's history (`refs/remotes/origin/*`), or `commit`
   * itself when it is one. `have` are the drive's refs.
   */
  const remoteBase = (commit: string, have: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      if (!remoteBacked) return [];
      /** Whether the drive holds `oid`: its refs reach it in the drive's own view. */
      const held = (oid: string) =>
        have.length === 0
          ? Effect.succeed(false)
          : Effect.map(
              git.run(["--shallow-file", driveShallow, "rev-list", "-n1", oid, "--not", ...have]),
              (out) => out.trim() === "",
            );
      const walked = git.lines(
        yield* git.run(["rev-list", "--boundary", commit, "--not", ...have, "--remotes=origin"]),
      );
      const remote: Array<string> = [];
      for (const line of walked.filter((entry) => entry.startsWith("-"))) {
        if (!(yield* held(line.slice(1)))) remote.push(line.slice(1));
      }
      if (walked.length === 0 && !(yield* held(commit))) {
        const onOrigin = yield* git.run([
          "for-each-ref",
          "--count=1",
          "--contains",
          commit,
          "refs/remotes/origin",
        ]);
        if (onOrigin.trim() !== "") remote.push(commit);
      }
      return remote;
    });

  /** Marks a fetched pull target as remote-owned only while it is outside the drive's history. */
  const pullRemoteBase = (commit: string, target: string, bases: ReadonlyArray<string> = []) =>
    Effect.gen(function* () {
      if (!remoteBacked || !(yield* git.isAncestor(target, commit))) return undefined;
      const have = [
        ...[known.main, known.thread, known.wip].filter((oid) => oid !== null),
        ...bases,
      ];
      if (have.length === 0) return [target];
      const held = yield* git.run([
        "--shallow-file",
        driveShallow,
        "rev-list",
        "-n1",
        target,
        "--not",
        ...have,
      ]);
      return held.trim() === "" ? undefined : [target];
    });

  /**
   * Uploads what `commit` reaches that the drive lacks, as one full (not thin)
   * pack, through the drive's view. Remote commits it carries one deep keep
   * their files on the remote. `remoteHead`: `commit` is the remote's head,
   * for `main`. `private`: `commit` is the thread's machine state, whose pack
   * only this thread is handed; it may lean on the drive's other packs, but
   * no other pack ever leans on it.
   */
  const upload = (
    commit: string,
    options: {
      readonly remoteHead?: boolean;
      readonly remoteCommits?: ReadonlyArray<string>;
      readonly private?: boolean;
      readonly bases?: ReadonlyArray<string>;
    } = {},
  ) =>
    Effect.gen(function* () {
      if (!(yield* fs.exists(driveShallow))) yield* fs.writeFileString(driveShallow, "");
      const have = [
        known.main,
        known.thread,
        known.wip,
        ...(options.bases ?? []),
        ...(options.private === true ? [known.machine] : []),
      ].filter((oid) => oid !== null);
      const remote = options.remoteCommits ?? (yield* remoteBase(commit, have));
      if (remote.length > MAX_REMOTE_COMMITS) {
        return yield* new DriveRefusedError({
          message: `This branch builds on ${remote.length} commits from GitHub that Signalbox doesn't hold, more than ${MAX_REMOTE_COMMITS} at once. Rebase it onto the latest main and try again.`,
        });
      }
      const tmp = yield* fs.makeTempDirectory({ directory: gitDir, prefix: "drive-pack-" });
      yield* Effect.gen(function* () {
        // The drive's view, with the remote commits this upload brings in one deep.
        const shallowFile = path.join(tmp, "shallow");
        yield* fs.writeFileString(
          shallowFile,
          `${yield* fs.readFileString(driveShallow)}${remote.map((oid) => `${oid}\n`).join("")}`,
        );
        // `^<ref>^{tree}`: a remote commit cut from its parents doesn't reach the drive's
        // commits, so their folders are excluded by name, or each new main would send them all.
        const revs = [commit, ...have.flatMap((oid) => [`^${oid}`, `^${oid}^{tree}`]), ""].join(
          "\n",
        );
        const listed = git.lines(
          yield* git.run(
            [
              "--shallow-file",
              shallowFile,
              "rev-list",
              "--objects",
              "--missing=allow-promisor",
              "--stdin",
            ],
            { stdin: revs },
          ),
        );
        if (listed.length === 0) return;
        // The remote commits' files stay on the remote; files this thread wrote travel.
        const kept = new Set<string>();
        for (const oid of remote) {
          for (const file of git.lines(
            yield* git.run(["ls-tree", "-r", "--format=%(objectname)", oid]),
          )) {
            kept.add(file);
          }
        }
        // Packed by name: git before 2.42 filters `pack-objects` only into `--stdout`.
        const hash = (yield* git.run(
          ["pack-objects", "--delta-base-offset", "-q", path.join(tmp, "pack")],
          {
            stdin: [...listed.filter((line) => !kept.has(line.slice(0, 40))), ""].join("\n"),
          },
        )).trim();
        const file = (ext: string) => path.join(tmp, `pack-${hash}.${ext}`);
        const others = remote.filter((oid) => !(options.remoteHead === true && oid === commit));
        const result = yield* client.uploadPack(
          { idx: file("idx"), pack: file("pack") },
          {
            ...(options.remoteHead === true ? { remoteHead: commit } : {}),
            ...(others.length > 0 ? { remoteCommits: others } : {}),
            ...(options.private === true ? { private: true } : {}),
          },
        );
        // Kept, so the next `open` does not download it back. The index goes last.
        yield* fs.rename(file("pack"), path.join(packDir, `pack-${result.name}.pack`));
        yield* fs.rename(file("idx"), path.join(packDir, `pack-${result.name}.idx`));
        if (remoteBacked) {
          yield* fs.writeFileString(path.join(packDir, `pack-${result.name}.promisor`), "");
        }
        yield* git.run(["multi-pack-index", "write"]);
      }).pipe(Effect.ensuring(fs.remove(tmp, { recursive: true }).pipe(Effect.ignore)));
    });

  /** CAS-moves the thread's refs, adopting each answer; a refusal's reason, or null. */
  const moveRefs = (targets: ReadonlyArray<{ readonly ref: ThreadRefName; readonly to: string }>) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < REF_ATTEMPTS; attempt++) {
        const updates = targets
          .filter((target) => known[target.ref] !== target.to)
          .map((target) => ({ ref: target.ref, old: known[target.ref], new: target.to }));
        if (updates.length === 0) return null;
        const result = yield* client.updateRefs(updates);
        if (result._tag === "refused") return result.reason;
        yield* adopt(result.state);
        if (result._tag === "ok") return null;
      }
      return "The thread's refs kept moving.";
    });

  return {
    /** The drive's refs as last seen. */
    known: () => known,
    /** Opens the drive and mirrors it. */
    open: client.open.pipe(
      Effect.tap(adopt),
      Effect.map(() => known),
    ),
    adopt,
    /** Reads the drive and mirrors it, without opening it for the thread. */
    refresh: client.state.pipe(
      Effect.tap(adopt),
      Effect.map((state) => state.remote),
    ),
    /**
     * Uploads the remote's head and moves `main` to it. Another thread may
     * have done the same meanwhile; answers a refusal's reason, or null.
     */
    mirrorMain: (head: string) =>
      Effect.gen(function* () {
        if (known.main === head) return null;
        yield* upload(head, { remoteHead: true });
        for (let attempt = 0; attempt < REF_ATTEMPTS; attempt++) {
          const result = yield* client.mirror({ expectedMain: known.main, newMain: head });
          if (result._tag === "refused") return result.reason;
          yield* adopt(result.state);
          if (result._tag === "ok") return null;
        }
        return "main kept moving.";
      }),
    /** Saves `commit` as the auto-save. */
    saveWip: (commit: string) =>
      upload(commit).pipe(Effect.andThen(moveRefs([{ ref: "wip", to: commit }]))),
    /** Saves a pull with both branch refs tied to the exact operation receipt. */
    savePull: (operation: PullOperation, result: PullResult) =>
      Effect.gen(function* () {
        if (result.outcome !== "refused") {
          if (result.head !== null && result.head !== known.thread) {
            const remoteCommits = yield* pullRemoteBase(result.head, operation.target);
            yield* upload(result.head, remoteCommits === undefined ? {} : { remoteCommits });
          }
          if (result.wip !== null && result.wip !== result.head && result.wip !== known.wip) {
            const bases = result.head === null ? [] : [result.head];
            const remoteCommits = yield* pullRemoteBase(result.wip, operation.target, bases);
            yield* upload(result.wip, {
              ...(bases.length === 0 ? {} : { bases }),
              ...(remoteCommits === undefined ? {} : { remoteCommits }),
            });
          }
        }

        const saved = yield* client.savePull({ operation, result });
        if (saved.outcome === "refused") return saved;
        known = { ...known, thread: saved.head, wip: saved.wip };
        yield* Effect.all(
          [git.setRef("refs/drive/thread", saved.head), git.setRef("refs/drive/wip", saved.wip)],
          { concurrency: 2, discard: true },
        );
        return saved;
      }),
    pullReceipt: client.pullReceipt,
    /** Whether the cloud keeps the thread's machine state. */
    keepsMachine: () => keepsMachine,
    /** Saves `commit` as the thread's machine state, in a pack only this thread is handed. */
    saveMachine: (commit: string) =>
      upload(commit, { private: true }).pipe(
        Effect.andThen(moveRefs([{ ref: "machine", to: commit }])),
      ),
    /** Saves the thread's branch at `head`: `thread` and `wip` both move to it. */
    saveBranch: (head: string) =>
      upload(head).pipe(
        Effect.andThen(
          moveRefs([
            { ref: "thread", to: head },
            { ref: "wip", to: head },
          ]),
        ),
      ),
    /** Uploads the updated notes ref without exposing it as a branch or pushing it to a remote. */
    saveNotes: (head: string) => upload(head, { bases: knownNotes === null ? [] : [knownNotes] }),
  };
});
