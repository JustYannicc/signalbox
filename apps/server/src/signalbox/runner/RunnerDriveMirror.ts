import type { DriveState, ThreadRefName } from "@signalbox/runner-protocol/DriveProtocol";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type { DriveClient } from "./RunnerDriveClient.ts";
import type { RunnerGit } from "./RunnerGit.ts";

/**
 * What the local repository knows of its drive, and how objects and refs move
 * between them. `refs/drive/{main,thread,wip}` mirror the drive's refs as
 * last seen, and only ever name commits the drive has, so a pack of what a
 * commit reaches `^` those refs is closed: everything it points at is in the
 * pack or already in the drive.
 */

const REF_ATTEMPTS = 3;

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

  /** One index over every pack, so lookups stay fast as auto-saves pile packs up. */
  const indexPacks = git.run(["multi-pack-index", "write"]).pipe(Effect.asVoid);

  /** Fetches the drive's packs we lack, then mirrors its refs. */
  const adopt = (state: DriveState) =>
    Effect.gen(function* () {
      yield* Effect.forEach(state.packs, (pack) => client.downloadPack(pack.name, packDir), {
        concurrency: 8,
        discard: true,
      });
      if (state.packs.length > 0) {
        client.havePacksThrough(Math.max(...state.packs.map((pack) => pack.seq)));
        yield* indexPacks;
      }
      for (const ref of ["main", "thread", "wip"] as const) {
        yield* git.setRef(`refs/drive/${ref}`, state[ref]);
      }
      known = { main: state.main, thread: state.thread, wip: state.wip };
    });

  /** Uploads what `commit` reaches that the drive lacks, as one full (not thin) pack. */
  const upload = (commit: string) =>
    Effect.gen(function* () {
      const have = [known.main, known.thread, known.wip].filter((oid) => oid !== null);
      const fresh = yield* git.run(["rev-list", "--count", commit, "--not", ...have]);
      if (Number(fresh.trim()) === 0) return;
      const tmp = yield* fs.makeTempDirectory({ directory: gitDir, prefix: "drive-pack-" });
      yield* Effect.gen(function* () {
        const stdin = [commit, ...have.map((oid) => `^${oid}`), ""].join("\n");
        const args = [
          "pack-objects",
          "--revs",
          "--delta-base-offset",
          "-q",
          path.join(tmp, "pack"),
        ];
        const hash = (yield* git.run(args, { stdin })).trim();
        const file = (ext: string) => path.join(tmp, `pack-${hash}.${ext}`);
        const result = yield* client.uploadPack(
          yield* fs.readFile(file("idx")),
          yield* fs.readFile(file("pack")),
        );
        // Kept, so the next `open` does not download it back. The index goes last.
        yield* fs.rename(file("pack"), path.join(packDir, `pack-${result.name}.pack`));
        yield* fs.rename(file("idx"), path.join(packDir, `pack-${result.name}.idx`));
        yield* indexPacks;
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
