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
 * - `POST packs/direct` asks to upload straight to storage instead (#406):
 *   the answer is a pair of short-lived URLs to `PUT` the pack and its index
 *   to, or `inline` when this cloud has none to give. `POST packs/direct/commit`
 *   then has the cloud read the upload back, check it the same way (streamed,
 *   so its size never meets a request's or an isolate's limit) and store it.
 * - `refs` moves the thread's own `thread`, `wip` and `machine` refs, each a
 *   CAS from an old value, to commits the drive already has.
 * - `machine` is the thread's machine state (#490): what a save leaves out of
 *   `wip` because git ignores it (`.env`, `notes/`, local data) and the
 *   thread's home outside the checkout. It's the thread's alone: its packs
 *   upload with `PRIVATE_PACK_HEADER`, only that thread's machines download
 *   them, and nothing it holds is ever merged or pushed to a remote.
 * - `reconcile` fast-forwards `main` to the thread's branch. Only while the
 *   thread's turn runs, and only from the `main` the thread merged.
 *
 * Every call carries the thread's drive token as a bearer token. It names the
 * thread and its machine generation; a token from an older machine, or for
 * another thread's refs, is refused.
 *
 * A drive with a remote repository (#135) can use it as its home or as a
 * content source:
 *
 * - `state` reads the drive without opening it, so a new thread can bring
 *   `main` up to date before its branch starts there.
 * - `remote` is the remote repository over git's smart HTTP, fetch only, with
 *   the turn's remote token as bearer. The cloud adds the credential; the
 *   machine never holds one, and the token stops working when the turn ends.
 * - With no `mode`, `main` mirrors the remote's default branch: the machine fetches the
 *   remote's history (blobless, #394), uploads its head with
 *   `REMOTE_HEAD_HEADER` (the drive holds it one commit deep, its files
 *   promised), and `mirror`s `main` to it. The cloud checks both against the
 *   remote. Such a drive never `reconcile`s; merging a pull request on the
 *   remote lands the work.
 * - With `mode: "source"`, the drive keeps its own `main` and reconciles its
 *   threads there. The machine still fetches the remote's history and gets
 *   promised blobs from it, but never mirrors its advancing default branch.
 *
 * A drive's shortcuts (#142) show other drives at paths of its tree, read-only
 * and with their own history. The machine mounts each one as a repository of
 * its own there:
 *
 * - `shortcuts` lists them with each target's `main` and packs, as the
 *   thread's user may read them right now. A target they can't open is listed
 *   as unreadable, so the machine takes it down.
 * - `shortcuts/<target>/packs/<name>.pack|.idx` downloads a target's pack.
 * - `remote/shortcuts/<target>/…` fetches a remote-backed target's remote,
 *   like `remote`, with the turn's remote token.
 *
 * `<target>` is the target's drive id, URI-encoded.
 */

export const DRIVE_API_PREFIX = "/api/drive";
export const DRIVE_PATHS = {
  open: `${DRIVE_API_PREFIX}/open`,
  state: `${DRIVE_API_PREFIX}/state`,
  packs: `${DRIVE_API_PREFIX}/packs`,
  refs: `${DRIVE_API_PREFIX}/refs`,
  reconcile: `${DRIVE_API_PREFIX}/reconcile`,
  mirror: `${DRIVE_API_PREFIX}/mirror`,
  directUpload: `${DRIVE_API_PREFIX}/packs/direct`,
  directCommit: `${DRIVE_API_PREFIX}/packs/direct/commit`,
  /** A git smart-HTTP remote: `<remote>/info/refs` and `<remote>/git-upload-pack`. */
  remote: `${DRIVE_API_PREFIX}/remote`,
  shortcuts: `${DRIVE_API_PREFIX}/shortcuts`,
} as const;

/** Where a shortcut target's packs download from. */
export const shortcutPacksPath = (target: string) =>
  `${DRIVE_PATHS.shortcuts}/${encodeURIComponent(target)}/packs`;

/** Where git fetches a remote-backed shortcut target's remote through the cloud. */
export const shortcutRemotePath = (target: string) =>
  `${DRIVE_PATHS.remote}/shortcuts/${encodeURIComponent(target)}`;

/**
 * Header on a pack upload holding the remote's head commit. The commit's
 * parents stay on the remote, so the drive accepts it without them once the
 * cloud has checked that it is the remote's head.
 */
export const REMOTE_HEAD_HEADER = "x-signalbox-remote-head";

/**
 * Header on a pack upload: other commits in the pack that are on the remote,
 * comma-separated, at most `MAX_REMOTE_COMMITS` (#394). A thread with the
 * remote's history works on top of commits the drive doesn't hold: a main
 * newer than the drive's that it rebased onto, commits pulled from its own
 * branch on the remote. The pack carries those commits and their folders;
 * once the cloud has checked the remote has each, their parents and files
 * stay on the remote, as a remote head's do.
 */
export const REMOTE_COMMITS_HEADER = "x-signalbox-remote-commits";
export const MAX_REMOTE_COMMITS = 16;

/**
 * Header on a pack upload, `1` when the pack is the uploading thread's own
 * (its machine state): only that thread is ever handed it. It may build on
 * everything else in the drive; nothing else may build on it.
 */
export const PRIVATE_PACK_HEADER = "x-signalbox-private";

/** A thread's own branch on its drive's remote, where pushing and its pull request go. */
export const threadRemoteBranch = (threadId: string) =>
  `signalbox/${threadId
    .replace(/[^0-9a-zA-Z]/g, "")
    .slice(-8)
    .toLowerCase()}`;

/**
 * Header on every call: the highest pack sequence the machine already has.
 * States list only newer packs, so a drive's growing pack list is sent once.
 */
export const PACKS_AFTER_HEADER = "x-signalbox-packs-after";

/** Header on a pack upload: the index's length. The body is the index, then the pack. */
export const PACK_INDEX_LENGTH_HEADER = "x-signalbox-idx-length";

/**
 * Biggest pack a drive accepts in a request's body (`POST packs`): the cloud
 * reads the whole body into memory to check it. A direct upload has no such
 * limit (`MAX_DIRECT_PACK_BYTES`).
 */
export const MAX_PACK_BYTES = 64 * 1024 * 1024;

/** Biggest pack a direct upload takes: what storage takes in one `PUT`, a little under 5 GiB. */
export const MAX_DIRECT_PACK_BYTES = 5 * 1024 ** 3 - 5 * 1024 ** 2;

export const Oid = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));
export type Oid = typeof Oid.Type;

/** Who a drive commit is by, as git's `user.name` and `user.email`. */
export const CommitAuthor = Schema.Struct({ name: Schema.String, email: Schema.String });
export type CommitAuthor = typeof CommitAuthor.Type;

/**
 * Who drive commits made by Signalbox are by when no one else is: a reserved
 * address that never delivers mail.
 */
export const DRIVE_COMMIT_AUTHOR: CommitAuthor = {
  name: "Signalbox",
  email: "agent@signalbox.invalid",
};

/** The message of the commit a turn's reconcile makes when it merges `main` in. */
export const DRIVE_MERGE_MESSAGE = "Merge main";

/** The id of the empty tree: what an empty drive or an unborn branch diffs from. */
export const EMPTY_TREE: Oid = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** A pack's name: the hex checksum git gives it (`pack-<name>.pack`). */
const PackName = Oid;

export const DrivePack = Schema.Struct({
  seq: NonNegativeInt,
  name: PackName,
  size: NonNegativeInt,
});

/** The remote repository a drive is backed by. */
export const DriveRemote = Schema.Struct({
  provider: Schema.Literal("github"),
  /** `owner/name`. */
  repository: Schema.String,
  defaultBranch: Schema.String,
  /** Omit for a drive whose main mirrors this repository. */
  mode: Schema.optional(Schema.Literal("source")),
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
  /** The thread's machine state, `machine/<thread id>`; absent from a cloud that keeps none. */
  machine: Schema.optional(Schema.NullOr(Oid)),
  /** Where the thread's branch started: `main` when the thread first opened the drive. */
  base: Schema.NullOr(Oid),
  /** The drive's packs after the caller's `PACKS_AFTER_HEADER`, oldest first. */
  packs: Schema.Array(DrivePack),
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

/**
 * A folder a save leaves out of the thread's machine state (#490), and how it
 * comes back: shown in the thread's details.
 */
export const SkippedFolder = Schema.Struct({
  /** Relative to the checkout, or `~/…` outside it. */
  path: Schema.String,
  recipe: Schema.String,
});
export type SkippedFolder = typeof SkippedFolder.Type;

/** The thread's own refs, the only ones `refs` can move. */
export const ThreadRefName = Schema.Literals(["thread", "wip", "machine"]);
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

/** A shortcut of the thread's drive, and its target as the thread's user may read it. */
export const DriveShortcut = Schema.Struct({
  /** Where it shows, relative to the drive's root. */
  path: Schema.String,
  target: Schema.String,
  /** False when the user can't open the target: the rest is empty, and nothing is mounted. */
  readable: Schema.Boolean,
  main: Schema.NullOr(Oid),
  /** The target's packs after the caller's `have` for it, oldest first. */
  packs: Schema.Array(DrivePack),
  shallow: Schema.Array(Oid),
  remote: Schema.NullOr(DriveRemote),
});
export type DriveShortcut = typeof DriveShortcut.Type;

export const ShortcutsRequest = Schema.Struct({
  /** Per target, the highest pack sequence the machine already has. */
  have: Schema.Record(Schema.String, NonNegativeInt),
});

export const ShortcutsAnswer = Schema.Struct({ shortcuts: Schema.Array(DriveShortcut) });

/**
 * One level's `AGENTS.md` on a thread's chain (its top level, then each
 * folder down to its home), labeled with the level it's from.
 */
export const FolderInstructions = Schema.Struct({ label: Schema.String, text: Schema.String });
export type FolderInstructions = typeof FolderInstructions.Type;

/** What a thread's machine gets with each turn: its drive and the token for it. */
export const DriveAccess = Schema.Struct({
  driveId: Schema.String,
  token: Schema.String,
  /**
   * This turn's bearer for remotes, good only while the turn runs: the
   * drive's own (`remote`) and its shortcut targets'. Null when the cloud
   * issues none.
   */
  remoteToken: Schema.NullOr(Schema.String),
  /**
   * Who the turn's commits are by: the thread's owner as GitHub knows them,
   * so commits they push show as theirs. Absent when they have no GitHub
   * connected, or from a cloud older than this field: `DRIVE_COMMIT_AUTHOR`.
   */
  author: Schema.optionalKey(CommitAuthor),
  /**
   * The instructions of the thread's chain, top level first, which agents
   * follow before the drive's own `AGENTS.md`. Absent from a cloud older than
   * this field: none.
   */
  instructions: Schema.optionalKey(Schema.Array(FolderInstructions)),
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

/** A machine asking to upload a pack straight to storage. */
export const DirectUploadRequest = Schema.Struct({
  packSize: NonNegativeInt,
  idxSize: NonNegativeInt,
});

/** Where to `PUT` the pack and its index, or `inline`: upload it in a request's body instead. */
export const DirectUploadOffer = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("direct"),
    uploadId: Schema.String,
    pack: Schema.String,
    idx: Schema.String,
  }),
  Schema.Struct({ _tag: Schema.Literal("inline") }),
]);
export type DirectUploadOffer = typeof DirectUploadOffer.Type;

/** A direct upload to check and store; `remoteHead` as `REMOTE_HEAD_HEADER` says it. */
export const DirectCommitRequest = Schema.Struct({
  uploadId: Schema.String,
  remoteHead: Schema.optional(Oid),
  /** As `REMOTE_COMMITS_HEADER` says them. */
  remoteCommits: Schema.optional(Schema.Array(Oid)),
  /** As `PRIVATE_PACK_HEADER` says it. */
  private: Schema.optional(Schema.Boolean),
});

export const driveJson = {
  state: jsonCodec(DriveState),
  packUpload: jsonCodec(PackUploadResult),
  refUpdate: jsonCodec(RefUpdateRequest),
  reconcile: jsonCodec(ReconcileRequest),
  /** `newMain` is the remote's head, already uploaded. */
  mirror: jsonCodec(ReconcileRequest),
  refWrite: jsonCodec(RefWriteResult),
  shortcutsRequest: jsonCodec(ShortcutsRequest),
  directUpload: jsonCodec(DirectUploadRequest),
  directOffer: jsonCodec(DirectUploadOffer),
  directCommit: jsonCodec(DirectCommitRequest),
  shortcuts: jsonCodec(ShortcutsAnswer),
};
