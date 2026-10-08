import { NonNegativeInt, PositiveInt } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { DRIVE_API_PREFIX, Oid } from "./DriveProtocol.ts";
import { jsonCodec } from "./jsonCodec.ts";

/**
 * What a thread's machine reads beyond its own drive (#141): every drive its
 * user can read, across contexts, and the context tool's search over their
 * threads, the drives' history and other threads' unreconciled work. All of it
 * is read-only. Calls carry the thread's drive token (`DriveProtocol.ts`), and
 * the cloud asks the user's access again on every one, so a drive someone
 * loses stops reading at once.
 *
 * - `view` lists the readable drives, each with the commit it is read at: its
 *   `main` right now. The machine takes one view per turn, so everything a
 *   turn reads is one pinned version.
 * - `tree` lists a directory, or describes a file, at a commit of one drive.
 *   Shortcuts are the machine's to follow, with the view's commit of the
 *   drive they point at.
 * - `blob` answers a file's bytes by object id: 404 when the drive has no such
 *   object, 413 when it is bigger than `MAX_CONTEXT_BLOB_BYTES`.
 * - `diff` is a patch between two commits of one drive.
 * - `search` and `thread` are the context tool. Search answers
 *   `insufficient_evidence` rather than its closest guess.
 */

export const CONTEXT_API_PREFIX = `${DRIVE_API_PREFIX}/context`;
export const CONTEXT_PATHS = {
  view: `${CONTEXT_API_PREFIX}/view`,
  tree: `${CONTEXT_API_PREFIX}/tree`,
  blob: `${CONTEXT_API_PREFIX}/blob`,
  diff: `${CONTEXT_API_PREFIX}/diff`,
  search: `${CONTEXT_API_PREFIX}/search`,
  thread: `${CONTEXT_API_PREFIX}/thread`,
} as const;

/** Biggest file `blob` answers. Bigger files are stored apart from packs later (#119). */
export const MAX_CONTEXT_BLOB_BYTES = 8 * 1024 * 1024;

export const ContextShortcut = Schema.Struct({ path: Schema.String, target: Schema.String });

export const ContextDrive = Schema.Struct({
  driveId: Schema.String,
  /**
   * Where the drive shows in its context's folder: `My Drive`,
   * `Shared drives/<name>` or `Shared with me/<name>`. Null for a drive only
   * reached through a shortcut, such as a folder its owner split out to share.
   */
  path: Schema.NullOr(Schema.String),
  /** The commit this view reads, `main` when it was taken; null for an empty drive. */
  commit: Schema.NullOr(Oid),
  /** When `commit` was made, in seconds since the epoch. */
  time: Schema.NullOr(Schema.Number),
  shortcuts: Schema.Array(ContextShortcut),
});
export type ContextDrive = typeof ContextDrive.Type;

export const ContextView = Schema.Struct({
  /** The thread's own drive: the one its working directory checks out. */
  driveId: Schema.String,
  contexts: Schema.Array(
    Schema.Struct({
      contextId: Schema.String,
      /** The context's folder under `/drives`: its name, unique among the user's contexts. */
      name: Schema.String,
      drives: Schema.Array(ContextDrive),
    }),
  ),
});
export type ContextView = typeof ContextView.Type;

export const TreeRequest = Schema.Struct({
  driveId: Schema.String,
  commit: Oid,
  /** Slash-separated, relative to the drive's root; `""` is the root. */
  path: Schema.String,
});

export const ContextEntry = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literals(["file", "directory", "symlink"]),
  oid: Oid,
  /** Bytes; 0 for a directory. */
  size: NonNegativeInt,
});
export type ContextEntry = typeof ContextEntry.Type;

export const TreeResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("directory"), entries: Schema.Array(ContextEntry) }),
  Schema.Struct({ _tag: Schema.Literal("file"), entry: ContextEntry }),
  Schema.Struct({ _tag: Schema.Literal("missing") }),
]);
export type TreeResult = typeof TreeResult.Type;

export const BlobRequest = Schema.Struct({ driveId: Schema.String, oid: Oid });

export const DiffRequest = Schema.Struct({
  driveId: Schema.String,
  /** Null diffs from nothing: every file of `to` is added. */
  from: Schema.NullOr(Oid),
  to: Oid,
});

export const DiffResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("diff"), patch: Schema.String, truncated: Schema.Boolean }),
  Schema.Struct({ _tag: Schema.Literal("missing") }),
]);
export type DiffResult = typeof DiffResult.Type;

export const SearchRequest = Schema.Struct({
  query: Schema.String,
  /** Only this drive. Null: every drive the user can read. */
  driveId: Schema.NullOr(Schema.String),
});

/** A turn's saved files, as the commits its checkpoint names. */
export const TurnCommits = Schema.Struct({
  turn: PositiveInt,
  /** Where the turn started; null for a turn that began on an empty branch. */
  start: Schema.NullOr(Oid),
  commit: Oid,
});

const matched = Schema.Array(Schema.String);

export const SearchHit = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("thread"),
    threadId: Schema.String,
    title: Schema.String,
    driveId: Schema.NullOr(Schema.String),
    /** The query's words this thread matched. */
    matched,
    /** Files the thread's turns changed. */
    files: Schema.Array(Schema.String),
    /** Where in the conversation the words are, by message. */
    messages: Schema.Array(
      Schema.Struct({
        messageId: Schema.String,
        turn: Schema.NullOr(PositiveInt),
        role: Schema.String,
        excerpt: Schema.String,
      }),
    ),
    turns: Schema.Array(TurnCommits),
  }),
  Schema.Struct({
    kind: Schema.Literal("commit"),
    driveId: Schema.String,
    commit: Oid,
    parent: Schema.NullOr(Oid),
    message: Schema.String,
    time: Schema.Number,
    matched,
    files: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    /** A thread's work not yet reconciled into its drive's `main`. */
    kind: Schema.Literal("work"),
    driveId: Schema.String,
    threadId: Schema.String,
    /** The thread's title, when the user can see the thread; others' threads stay unnamed. */
    title: Schema.NullOr(Schema.String),
    commit: Oid,
    base: Schema.NullOr(Oid),
    matched,
    files: Schema.Array(Schema.String),
  }),
]);
export type SearchHit = typeof SearchHit.Type;

export const Searched = Schema.Struct({
  /** Threads whose conversations were read, of `threadsInScope`. */
  threads: NonNegativeInt,
  threadsInScope: NonNegativeInt,
  drives: NonNegativeInt,
  commits: NonNegativeInt,
  work: NonNegativeInt,
});
export type Searched = typeof Searched.Type;

export const SearchResult = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("found"),
    terms: Schema.Array(Schema.String),
    hits: Schema.Array(SearchHit),
    searched: Searched,
  }),
  Schema.Struct({
    _tag: Schema.Literal("insufficient_evidence"),
    terms: Schema.Array(Schema.String),
    reason: Schema.String,
    searched: Searched,
  }),
]);
export type SearchResult = typeof SearchResult.Type;

export const ThreadRequest = Schema.Struct({
  threadId: Schema.String,
  /** One turn in full. Null: every turn, each message cut short. */
  turn: Schema.NullOr(PositiveInt),
});

export const ThreadMessage = Schema.Struct({
  messageId: Schema.String,
  role: Schema.String,
  text: Schema.String,
  truncated: Schema.Boolean,
});

export const ThreadTurn = Schema.Struct({
  turn: PositiveInt,
  messages: Schema.Array(ThreadMessage),
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      kind: Schema.String,
      additions: NonNegativeInt,
      deletions: NonNegativeInt,
    }),
  ),
  commits: Schema.NullOr(TurnCommits),
});
export type ThreadTurn = typeof ThreadTurn.Type;

export const ThreadResult = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("thread"),
    threadId: Schema.String,
    title: Schema.String,
    driveId: Schema.NullOr(Schema.String),
    turns: Schema.Array(ThreadTurn),
    /** The thread's latest auto-save or branch, when `main` doesn't hold it yet. */
    unreconciled: Schema.NullOr(Schema.Struct({ commit: Oid, base: Schema.NullOr(Oid) })),
  }),
  Schema.Struct({ _tag: Schema.Literal("not_found") }),
]);
export type ThreadResult = typeof ThreadResult.Type;

export const contextJson = {
  view: jsonCodec(ContextView),
  treeRequest: jsonCodec(TreeRequest),
  tree: jsonCodec(TreeResult),
  blobRequest: jsonCodec(BlobRequest),
  diffRequest: jsonCodec(DiffRequest),
  diff: jsonCodec(DiffResult),
  searchRequest: jsonCodec(SearchRequest),
  search: jsonCodec(SearchResult),
  threadRequest: jsonCodec(ThreadRequest),
  thread: jsonCodec(ThreadResult),
};
