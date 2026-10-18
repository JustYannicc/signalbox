import { NonNegativeInt, PositiveInt, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  SearchItemKind,
  ThreadSearchInput,
  ThreadSearchResult,
} from "@t3tools/contracts/signalboxSearch";
import * as Schema from "effect/Schema";

import { DRIVE_API_PREFIX, Oid } from "./DriveProtocol.ts";
import { jsonCodec } from "./jsonCodec.ts";

/**
 * What a thread's machine reads beyond its own drive (#141): every drive its
 * user can read, across contexts, and the context tool's search over their
 * user's indexed thread items. All of it
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
 * - `search` and `thread` are the context tool. Search includes archived
 *   threads and reports index coverage alongside its matches.
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

/** Search options exposed to a thread agent; project scope stays server-derived. */
export const ContextSearchInput = Schema.Struct({
  query: ThreadSearchInput.fields.query,
  mode: ThreadSearchInput.fields.mode,
  threadId: ThreadSearchInput.fields.threadId,
  kinds: ThreadSearchInput.fields.kinds,
  limit: ThreadSearchInput.fields.limit,
  cursor: ThreadSearchInput.fields.cursor,
});
export type ContextSearchInput = typeof ContextSearchInput.Type;

export const SearchRequest = Schema.Struct({
  ...ContextSearchInput.fields,
  /** Server-intersected project scope; agents do not choose authority. */
  projectIds: ThreadSearchInput.fields.projectIds,
  /** Only this drive. Null: every drive the user can read. */
  driveId: Schema.NullOr(Schema.String),
});
export type SearchRequest = typeof SearchRequest.Type;

/** Internal legacy thread-scan cursor used only while drive history is reused. */
export const SearchThreadCursor = Schema.Struct({
  updatedAt: Schema.Number,
  threadId: Schema.String,
  threadReadFailures: Schema.optional(NonNegativeInt),
});
export type SearchThreadCursor = typeof SearchThreadCursor.Type;

/** A turn's saved files, as the commits its checkpoint names. */
export const TurnCommits = Schema.Struct({
  turn: PositiveInt,
  /** Where the turn started; null for a turn that began on an empty branch. */
  start: Schema.NullOr(Oid),
  commit: Oid,
});

const matched = Schema.Array(Schema.String);

/** Legacy drive history hits retained alongside indexed thread results. */
export const SearchHit = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("thread"),
    threadId: Schema.String,
    title: Schema.String,
    driveId: Schema.NullOr(Schema.String),
    matched,
    files: Schema.Array(Schema.String),
    messages: Schema.Array(
      Schema.Struct({
        messageId: Schema.String,
        turn: Schema.NullOr(PositiveInt),
        role: Schema.String,
        excerpt: Schema.String,
      }),
    ),
    messagesTruncated: Schema.optional(Schema.Boolean),
    turns: Schema.Array(TurnCommits),
    archived: Schema.optional(Schema.Boolean),
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
    kind: Schema.Literal("work"),
    driveId: Schema.String,
    threadId: Schema.String,
    title: Schema.NullOr(Schema.String),
    commit: Oid,
    base: Schema.NullOr(Oid),
    matched,
    files: Schema.Array(Schema.String),
    archived: Schema.optional(Schema.Boolean),
  }),
]);
export type SearchHit = typeof SearchHit.Type;

export const Searched = Schema.Struct({
  threads: NonNegativeInt,
  threadReadFailures: Schema.optional(NonNegativeInt),
  threadsInScope: NonNegativeInt,
  drives: NonNegativeInt,
  commits: NonNegativeInt,
  work: NonNegativeInt,
});
export type Searched = typeof Searched.Type;

/** Internal drive-history search result, not sent over the Runner protocol. */
export const SearchResult = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("found"),
    terms: Schema.Array(Schema.String),
    hits: Schema.Array(SearchHit),
    searched: Searched,
    nextThreadCursor: Schema.optional(Schema.NullOr(SearchThreadCursor)),
    threadCoverageComplete: Schema.optional(Schema.Boolean),
    driveHitsTruncated: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    _tag: Schema.Literal("insufficient_evidence"),
    terms: Schema.Array(Schema.String),
    reason: Schema.String,
    searched: Searched,
    nextThreadCursor: Schema.optional(Schema.NullOr(SearchThreadCursor)),
    threadCoverageComplete: Schema.optional(Schema.Boolean),
    driveHitsTruncated: Schema.optional(Schema.Boolean),
  }),
]);
export type SearchResult = typeof SearchResult.Type;

/** Opaque cursor and index coverage cross this boundary unchanged. */
export const ContextSearchResult = Schema.Struct({
  ...ThreadSearchResult.fields,
  /** Commits and unmerged work remain searchable alongside indexed thread items. */
  driveHits: Schema.Array(SearchHit),
  driveSearched: Searched,
  driveHitsTruncated: Schema.Boolean,
});
export type ContextSearchResult = typeof ContextSearchResult.Type;

export const ThreadRequest = Schema.Union([
  Schema.Struct({
    threadId: ThreadId,
    /** One turn in full. Null: every turn, each message cut short. */
    turn: Schema.NullOr(PositiveInt),
  }),
  Schema.Struct({
    threadId: ThreadId,
    itemId: Schema.String,
    /** A search hit's project keeps an exact-item read within its selected drive. */
    projectId: ProjectId,
  }),
]);
export type ThreadRequest = typeof ThreadRequest.Type;

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
  Schema.Struct({
    _tag: Schema.Literal("item"),
    threadId: ThreadId,
    projectId: ProjectId,
    title: Schema.String,
    archived: Schema.Boolean,
    snapshotSequence: NonNegativeInt,
    item: Schema.Struct({
      itemId: Schema.String,
      entryId: Schema.String,
      runId: Schema.NullOr(Schema.String),
      position: NonNegativeInt,
      kind: SearchItemKind,
      text: Schema.String,
      createdAt: Schema.NullOr(Schema.String),
    }),
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
  search: jsonCodec(ContextSearchResult),
  threadRequest: jsonCodec(ThreadRequest),
  thread: jsonCodec(ThreadResult),
};
