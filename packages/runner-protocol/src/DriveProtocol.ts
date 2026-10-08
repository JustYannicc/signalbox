import { NonNegativeInt } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { jsonCodec } from "./jsonCodec.ts";

/**
 * How a thread's machine reads and writes its drive (#119, #131). A drive is
 * a git repository with no git server: its objects live in immutable packs in
 * R2, and its refs in the drive's Durable Object. The machine is the only
 * writer, so writing is "upload a pack, then compare-and-swap a ref":
 *
 * - `open` names the drive, its refs and packs. It creates the thread's
 *   branch at `main` the first time, and pins that base.
 * - `GET packs/<name>.pack|.idx` downloads a pack. A machine fetches by
 *   dropping packs into `.git/objects/pack`.
 * - `POST packs` uploads one pack and its index. The drive checks every
 *   object, and accepts the pack only if everything its commits and trees
 *   point at is in it or already in the drive. Nothing is registered until
 *   the pack is stored, so a machine killed mid-upload leaves no trace.
 * - `refs` moves the thread's own `thread` and `wip` refs, each a CAS from an
 *   old value, to commits the drive already has.
 * - `reconcile` fast-forwards `main` to the thread's branch. Only while the
 *   thread's turn runs, and only from the `main` the thread merged.
 *
 * Every call carries the thread's drive token as a bearer token. It names the
 * thread and its machine generation; a token from an older machine, or for
 * another thread's refs, is refused.
 *
 * A drive backed by a remote repository (#135) keeps the remote as its home:
 *
 * - `state` reads the drive without opening it, so a new thread can bring
 *   `main` up to date before its branch starts there.
 * - `remote` is the remote repository over git's smart HTTP, fetch only, with
 *   the turn's remote token as bearer. The cloud adds the credential; the
 *   machine never holds one, and the token stops working when the turn ends.
 * - `main` mirrors the remote's default branch: the machine fetches its head
 *   (one commit deep), uploads it with `REMOTE_HEAD_HEADER`, and `mirror`s
 *   `main` to it. The cloud checks both against the remote. Such a drive
 *   never `reconcile`s; merging a pull request on the remote lands the work.
 */

export const DRIVE_API_PREFIX = "/api/drive";
export const DRIVE_PATHS = {
  open: `${DRIVE_API_PREFIX}/open`,
  state: `${DRIVE_API_PREFIX}/state`,
  packs: `${DRIVE_API_PREFIX}/packs`,
  refs: `${DRIVE_API_PREFIX}/refs`,
  reconcile: `${DRIVE_API_PREFIX}/reconcile`,
  mirror: `${DRIVE_API_PREFIX}/mirror`,
  /** A git smart-HTTP remote: `<remote>/info/refs` and `<remote>/git-upload-pack`. */
  remote: `${DRIVE_API_PREFIX}/remote`,
} as const;

/**
 * Header on a pack upload holding the remote's head commit. The commit's
 * parents stay on the remote, so the drive accepts it without them once the
 * cloud has checked that it is the remote's head.
 */
export const REMOTE_HEAD_HEADER = "x-signalbox-remote-head";

/**
 * Header on every call: the highest pack sequence the machine already has.
 * States list only newer packs, so a drive's growing pack list is sent once.
 */
export const PACKS_AFTER_HEADER = "x-signalbox-packs-after";

/** Header on a pack upload: the index's length. The body is the index, then the pack. */
export const PACK_INDEX_LENGTH_HEADER = "x-signalbox-idx-length";

/** Biggest pack a drive accepts in one upload. Large files are stored apart from packs later (#119). */
export const MAX_PACK_BYTES = 64 * 1024 * 1024;

export const Oid = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));
export type Oid = typeof Oid.Type;

/** Who drive commits made by Signalbox are by: a reserved address that never delivers mail. */
export const DRIVE_COMMIT_AUTHOR = { name: "Signalbox", email: "agent@signalbox.invalid" } as const;

/** The id of the empty tree: what an empty drive or an unborn branch diffs from. */
export const EMPTY_TREE: Oid = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** A pack's name: the hex checksum git gives it (`pack-<name>.pack`). */
const PackName = Oid;

/** The remote repository a drive is backed by. */
export const DriveRemote = Schema.Struct({
  provider: Schema.Literal("github"),
  /** `owner/name`. */
  repository: Schema.String,
  defaultBranch: Schema.String,
});
export type DriveRemote = typeof DriveRemote.Type;

/** What a thread sees of its drive. */
export const DriveState = Schema.Struct({
  driveId: Schema.String,
  main: Schema.NullOr(Oid),
  /** The thread's branch, `threads/<thread id>`. */
  thread: Schema.NullOr(Oid),
  /** The thread's latest auto-save, `wip/<thread id>`. */
  wip: Schema.NullOr(Oid),
  /** Where the thread's branch started: `main` when the thread first opened the drive. */
  base: Schema.NullOr(Oid),
  /** The drive's packs after the caller's `PACKS_AFTER_HEADER`, oldest first. */
  packs: Schema.Array(Schema.Struct({ seq: NonNegativeInt, name: PackName, size: NonNegativeInt })),
  /** The remote repository this drive is backed by; null for a drive that is its own home. */
  remote: Schema.NullOr(DriveRemote),
  /**
   * Commits in `packs` whose parents stay on the remote: a repository holding
   * these packs lists them in `.git/shallow`.
   */
  shallow: Schema.Array(Oid),
});
export type DriveState = typeof DriveState.Type;

export const PackUploadResult = Schema.Struct({ name: PackName, objects: NonNegativeInt });

/** The thread's own refs, the only ones `refs` can move. */
export const ThreadRefName = Schema.Literals(["thread", "wip"]);
export type ThreadRefName = typeof ThreadRefName.Type;

export const RefUpdate = Schema.Struct({
  ref: ThreadRefName,
  old: Schema.NullOr(Oid),
  new: Oid,
});
export type RefUpdate = typeof RefUpdate.Type;

const RefUpdateRequest = Schema.Struct({ updates: Schema.Array(RefUpdate) });

export const ReconcileRequest = Schema.Struct({
  /** The `main` the thread merged into its branch; null when the drive had none. */
  expectedMain: Schema.NullOr(Oid),
  /** The thread's branch, which `main` moves to. */
  newMain: Oid,
});

/**
 * What a ref write answers. `conflict`: a ref was not at the value the thread
 * expected (another writer moved it); fetch and try again. `refused`: the
 * write is not allowed and will not be, whatever the thread retries.
 */
export const RefWriteResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("ok"), state: DriveState }),
  Schema.Struct({ _tag: Schema.Literal("conflict"), state: DriveState }),
  Schema.Struct({ _tag: Schema.Literal("refused"), reason: Schema.String }),
]);
export type RefWriteResult = typeof RefWriteResult.Type;

/** What a thread's machine gets with each turn: its drive and the token for it. */
export const DriveAccess = Schema.Struct({
  driveId: Schema.String,
  token: Schema.String,
  /**
   * This turn's bearer for the drive's `remote`, good only while the turn
   * runs. Null for a drive that is its own home.
   */
  remoteToken: Schema.NullOr(Schema.String),
});
export type DriveAccess = typeof DriveAccess.Type;

/** One file a checkpoint changed, as `git diff --numstat` counts it. */
export const DriveFileChange = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literals(["added", "modified", "deleted", "renamed"]),
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type DriveFileChange = typeof DriveFileChange.Type;

export const driveJson = {
  state: jsonCodec(DriveState),
  packUpload: jsonCodec(PackUploadResult),
  refUpdate: jsonCodec(RefUpdateRequest),
  reconcile: jsonCodec(ReconcileRequest),
  /** `newMain` is the remote's head, already uploaded. */
  mirror: jsonCodec(ReconcileRequest),
  refWrite: jsonCodec(RefWriteResult),
};
