import type { DriveState, ThreadRefName } from "@signalbox/runner-protocol/DriveProtocol";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type { DriveClient, DriveClientError } from "./RunnerDriveClient.ts";
import type { RunnerGit } from "./RunnerGit.ts";

/**
 * What the local repository knows of its drive, and how objects and refs move
 * between them. `refs/drive/{main,thread,wip}` mirror the drive's refs as
 * last seen, and only ever name commits the drive has, so a pack of what a
 * commit reaches `^` those refs is closed: everything it points at is in the
 * pack or already in the drive. A remote-backed drive's `main` is the
 * remote's head, fetched one commit deep (the repository is shallow there).
 * A pack of it holds the commit and its folders, never its files (#406): the
 * remote has those, and the drive records them as promised. The repository
 * here is a partial clone with the cloud's fetch proxy as its promisor, so git
 * fetches a promised file when it needs one; the drive's packs are promisor
 * packs.
 */

const REF_ATTEMPTS = 3;

/**
 * Puts a drive's `packs` into the repository at `gitDir` with `download`,
 * lists `shallow` commits in `.git/shallow`, and indexes every pack. Answers
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
    // Commits whose parents stay on the remote, so git never looks for them.
    const file = path.join(input.gitDir, "shallow");
    const current = (yield* fs.exists(file)) ? yield* fs.readFileString(file) : "";
    const listed = new Set(current.split("\n").filter((line) => line.length > 0));
    const missing = input.shallow.filter((oid) => !listed.has(oid));
    if (missing.length > 0) {
      yield* fs.writeFileString(file, [...listed, ...missing, ""].join("\n"));
    }
  }
  if (input.packs.length === 0) return null;
  // One index over every pack, so lookups stay fast as auto-saves pile packs up.
  yield* input.git.run(["multi-pack-index", "write"]);
  return Math.max(...input.packs.map((pack) => pack.seq));
});

export type DriveRefs = Readonly<Record<"main" | ThreadRefName, string | null>>;

export const makeDriveMirror = Effect.fn("makeDriveMirror")(function* (input: {
  readonly gitDir: string;
  readonly git: RunnerGit;
  readonly client: DriveClient;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { git, client, gitDir } = input;
  const packDir = path.join(gitDir, "objects", "pack");
  let known: DriveRefs = { main: null, thread: null, wip: null };

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
      for (const ref of ["main", "thread", "wip"] as const) {
        yield* git.setRef(`refs/drive/${ref}`, state[ref]);
      }
      known = { main: state.main, thread: state.thread, wip: state.wip };
    });

  /** Uploads what `commit` reaches that the drive lacks, as one full (not thin) pack. */
  const upload = (commit: string, options: { readonly remoteHead?: boolean } = {}) =>
    Effect.gen(function* () {
      const have = [known.main, known.thread, known.wip].filter((oid) => oid !== null);
      const fresh = yield* git.run(["rev-list", "--count", commit, "--not", ...have]);
      if (Number(fresh.trim()) === 0) return;
      const tmp = yield* fs.makeTempDirectory({ directory: gitDir, prefix: "drive-pack-" });
      yield* Effect.gen(function* () {
        // `^<ref>^{tree}`: the remote's head is cut from its parents, so it doesn't
        // reach the drive's commits; their folders are excluded by name instead.
        const stdin = [commit, ...have.flatMap((oid) => [`^${oid}`, `^${oid}^{tree}`]), ""].join(
          "\n",
        );
        const into = ["pack-objects", "--delta-base-offset", "-q", path.join(tmp, "pack")];
        // The remote's files stay on the remote: the drive holds them as promised. Listed
        // first and packed by name, since git before 2.42 filters only into `--stdout`.
        const hash = (
          options.remoteHead === true
            ? yield* git.run(into, {
                stdin: yield* git.run(["rev-list", "--objects", "--filter=blob:none", "--stdin"], {
                  stdin,
                }),
              })
            : yield* git.run(["pack-objects", "--revs", ...into.slice(1)], { stdin })
        ).trim();
        const file = (ext: string) => path.join(tmp, `pack-${hash}.${ext}`);
        const result = yield* client.uploadPack(
          { idx: file("idx"), pack: file("pack") },
          options.remoteHead === true ? { remoteHead: commit } : {},
        );
        // Kept, so the next `open` does not download it back. The index goes last.
        yield* fs.rename(file("pack"), path.join(packDir, `pack-${result.name}.pack`));
        yield* fs.rename(file("idx"), path.join(packDir, `pack-${result.name}.idx`));
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
  };
});
