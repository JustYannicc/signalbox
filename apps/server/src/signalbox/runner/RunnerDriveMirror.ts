import type { DriveState, ThreadRefName } from "@signalbox/runner-protocol/DriveProtocol";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import type { DriveClient, DriveClientError } from "./RunnerDriveClient.ts";
import type { RunnerGit, RunnerGitError } from "./RunnerGit.ts";

/**
 * What the local repository knows of its drive, and how objects and refs move
 * between them. `refs/drive/{main,thread,wip}` mirror the drive's refs as
 * last seen, and only ever name commits the drive has, so a pack of what a
 * commit reaches `^` those refs is closed: everything it points at is in the
 * pack or already in the drive. A remote-backed drive's `main` is the
 * remote's head, fetched one commit deep (the repository is shallow there),
 * so a pack of it holds its whole tree and leaves its parents on the remote.
 *
 * The drive takes packs up to `MAX_PACK_BYTES` (`client.maxPackBytes`): the cloud reads and checks
 * each one in memory, in an isolate of 128 MB, from a request body of at
 * most 100 MB. What a commit reaches can be bigger than that (a large
 * checkout), so an upload that doesn't fit goes as several packs, in an order
 * where each is closed on its own: the files in packs of their own, since a
 * file references nothing, then the folders and commits that point at them.
 */

const REF_ATTEMPTS = 3;
/** A part's estimated size, below the limit since packing it alone may compress worse. */
const PART_BUDGET = 0.75;

/** What a drive can't take in packs of its size, said for the person whose thread it is. */
export class DriveTooLargeError extends Schema.TaggedError<DriveTooLargeError>()(
  "DriveTooLargeError",
  { message: Schema.String },
) {}

const sizeLabel = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${Math.round(bytes / 1024 / 1024)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** One object to pack: `path` is where the commit's trees name it, for delta grouping and errors. */
interface PackObject {
  readonly oid: string;
  readonly path: string;
  readonly size: number;
  readonly disk: number;
}

/**
 * Puts a drive's `packs` into the repository at `gitDir` with `download`,
 * lists `shallow` commits in `.git/shallow`, and indexes every pack. Answers
 * the highest pack sequence stored, or null when there were none.
 */
export const storePacks = Effect.fn("storePacks")(function* (input: {
  readonly gitDir: string;
  readonly git: RunnerGit;
  readonly packs: DriveState["packs"];
  readonly shallow: DriveState["shallow"];
  readonly download: (name: string, packDir: string) => Effect.Effect<void, DriveClientError>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packDir = path.join(input.gitDir, "objects", "pack");
  yield* Effect.forEach(input.packs, (pack) => input.download(pack.name, packDir), {
    concurrency: 8,
    discard: true,
  });
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

  const maxPackBytes = client.maxPackBytes;
  const limit = sizeLabel(maxPackBytes);

  /** Packs `stdin` (`pack-objects` input) into `dir`; answers the pack's hash and size. */
  const writePack = (dir: string, args: ReadonlyArray<string>, stdin: string) =>
    Effect.gen(function* () {
      const base = path.join(dir, "pack");
      const hash = (yield* git.run(["pack-objects", ...args, "--delta-base-offset", "-q", base], {
        stdin,
      })).trim();
      const file = (ext: string) => `${base}-${hash}.${ext}`;
      const size = Number((yield* fs.stat(file("pack"))).size);
      return { file, size };
    });

  type Written = Effect.Success<ReturnType<typeof writePack>>;
  type PackError = DriveTooLargeError | RunnerGitError | PlatformError.PlatformError;

  const discard = (written: Written) =>
    Effect.all([fs.remove(written.file("pack")), fs.remove(written.file("idx"))], {
      discard: true,
    });

  /** Objects `revs` reach: the files apart from the folders and commits that point at them. */
  const listObjects = (revs: string) =>
    Effect.gen(function* () {
      const listed = yield* git.run(["rev-list", "--objects", "--stdin"], { stdin: revs });
      const checked = yield* git.run(
        [
          "cat-file",
          "--batch-check=%(objectname) %(objecttype) %(objectsize) %(objectsize:disk) %(rest)",
        ],
        { stdin: listed },
      );
      const blobs: Array<PackObject> = [];
      const rest: Array<PackObject> = [];
      for (const line of git.lines(checked)) {
        const [oid = "", type, size = "0", disk = "0"] = line.split(" ", 4);
        // `%(rest)` is the path `rev-list` gave, which may hold spaces.
        const path = line.split(" ").slice(4).join(" ");
        (type === "blob" ? blobs : rest).push({
          oid,
          path,
          size: Number(size),
          disk: Number(disk),
        });
      }
      return { blobs, rest };
    });

  /** `files` as packs the drive takes, halving a part that packs too big until one file alone is. */
  const packFiles = (
    dir: string,
    files: ReadonlyArray<PackObject>,
  ): Effect.Effect<ReadonlyArray<Written>, PackError> =>
    Effect.gen(function* () {
      if (files.length === 0) return [];
      const written = yield* writePack(
        dir,
        [],
        files.map((file) => `${file.oid} ${file.path}\n`).join(""),
      );
      if (written.size <= maxPackBytes) return [written];
      yield* discard(written);
      if (files.length === 1) {
        const [file] = files;
        return yield* new DriveTooLargeError({
          message: `${file!.path} is ${sizeLabel(file!.size)}, more than the ${limit} a drive stores in one piece.`,
        });
      }
      const half = Math.ceil(files.length / 2);
      return [
        ...(yield* packFiles(dir, files.slice(0, half))),
        ...(yield* packFiles(dir, files.slice(half))),
      ];
    });

  /** What `revs` reach as packs the drive takes, each closed given the ones before it. */
  const splitPacks = (dir: string, revs: string) =>
    Effect.gen(function* () {
      const { blobs, rest } = yield* listObjects(revs);
      // Files next to each other in the tree delta well together.
      const sorted = blobs.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      const groups: Array<Array<PackObject>> = [];
      let estimate = 0;
      for (const blob of sorted) {
        const current = groups.at(-1);
        if (current === undefined || estimate + blob.disk > maxPackBytes * PART_BUDGET) {
          groups.push([blob]);
          estimate = blob.disk;
        } else {
          current.push(blob);
          estimate += blob.disk;
        }
      }
      const parts: Array<Written> = [];
      for (const group of groups) parts.push(...(yield* packFiles(dir, group)));
      // Folders and commits reference each other in any order, so they go in one last pack.
      const last = yield* writePack(
        dir,
        [],
        rest.map((object) => `${object.oid} ${object.path}\n`).join(""),
      );
      if (last.size > maxPackBytes) {
        return yield* new DriveTooLargeError({
          message: `The repository's folders and commits come to ${sizeLabel(last.size)}, more than the ${limit} a drive stores in one piece.`,
        });
      }
      return [...parts, last];
    });

  /** Uploads what `commit` reaches that the drive lacks, as one full (not thin) pack, or several when that is too big. */
  const upload = (commit: string, options: { readonly remoteHead?: boolean } = {}) =>
    Effect.gen(function* () {
      const have = [known.main, known.thread, known.wip].filter((oid) => oid !== null);
      // What the new objects take on disk: zero when there are none, and close to their pack's size.
      const fresh = Number(
        (yield* git.run([
          "rev-list",
          "--objects",
          "--disk-usage",
          commit,
          "--not",
          ...have,
        ])).trim(),
      );
      if (fresh === 0) return;
      const tmp = yield* fs.makeTempDirectory({ directory: gitDir, prefix: "drive-pack-" });
      yield* Effect.gen(function* () {
        const revs = [commit, ...have.map((oid) => `^${oid}`), ""].join("\n");
        let parts: ReadonlyArray<Written>;
        if (fresh > maxPackBytes) {
          parts = yield* splitPacks(tmp, revs);
        } else {
          // The estimate can come in low; the pack itself decides.
          const whole = yield* writePack(tmp, ["--revs"], revs);
          if (whole.size <= maxPackBytes) parts = [whole];
          else {
            yield* discard(whole);
            parts = yield* splitPacks(tmp, revs);
          }
        }
        for (const [index, part] of parts.entries()) {
          // The remote's head is in the last part, with the commits.
          const last = index === parts.length - 1;
          const result = yield* client.uploadPack(
            yield* fs.readFile(part.file("idx")),
            yield* fs.readFile(part.file("pack")),
            last && options.remoteHead === true ? { remoteHead: commit } : {},
          );
          // Kept, so the next `open` does not download it back. The index goes last.
          yield* fs.rename(part.file("pack"), path.join(packDir, `pack-${result.name}.pack`));
          yield* fs.rename(part.file("idx"), path.join(packDir, `pack-${result.name}.idx`));
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
