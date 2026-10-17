import {
  type ContextDrive,
  type ContextEntry,
  type ContextView,
  type DiffResult,
  MAX_CONTEXT_BLOB_BYTES,
  type ContextSearchResult,
  type SearchRequest,
  type ThreadResult,
  type ThreadRequest,
  type TreeResult,
} from "@signalbox/runner-protocol/ContextProtocol";
import { ThreadId, type ProjectId } from "@t3tools/contracts";
import type { ThreadSearchInput } from "@t3tools/contracts/signalboxSearch";
import type { SignalboxContext } from "@t3tools/contracts/signalboxContexts";
import type { SignalboxDrive } from "@t3tools/contracts/signalboxDrives";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { DriveDirectory, type DriveObjectError } from "../drive/DriveDirectory.ts";
import { type DrivePackError, DrivePacks } from "../drive/DrivePacks.ts";
import { parseDriveId } from "../drive/driveAccess.ts";
import { pathSegments } from "../drive/DriveReader.ts";
import { remoteDriveReader } from "../drive/remoteFiles.ts";
import { GitHub } from "../github/GitHub.ts";
import { MAIN_REF } from "../drive/DriveStore.ts";
import type { Bytes, Oid } from "../drive/git/gitObjects.ts";
import { ThreadDirectory, type ThreadObjectError } from "../thread/ThreadDirectory.ts";
import type { Actor } from "../thread/ThreadEngine.ts";
import { UserDirectory, type UserObjectError } from "../user/UserDirectory.ts";
import { searchDriveHistory } from "./contextSearch.ts";
import { placeDrives } from "./contextView.ts";

/**
 * The context tool's reads, for one thread's machine (#141): everything the
 * thread's owner can read, across their contexts, and nothing they can't.
 * Every call asks the user's own object which drives that is right now, so
 * losing a drive or leaving an organization stops reads at once. Nothing here
 * writes; a thread changes only its own drive, through the drive API.
 */

/** Who reads: a thread's machine, acting for the thread's owner. */
export interface ContextReader {
  readonly userId: string;
  readonly threadId: string;
  /** The thread's own drive. */
  readonly driveId: string;
}

export class ContextAccessError extends Schema.TaggedError<ContextAccessError>()(
  "ContextAccessError",
  { message: Schema.String },
) {}

/** An object or the bucket failed; the machine retries. */
export type ContextUnavailable =
  | DriveObjectError
  | DrivePackError
  | UserObjectError
  | ThreadObjectError;

export type BlobResult =
  | { readonly _tag: "blob"; readonly bytes: Bytes }
  | { readonly _tag: "missing" | "too_large" };

/** Most of a patch `diff` answers; the rest is cut off and flagged. */
const MAX_PATCH_CHARS = 150_000;

const NO_ACCESS = "You can't read that drive.";

export interface ReaderSearchScope {
  readonly actor: Actor;
  readonly drives: ReadonlyArray<SignalboxDrive>;
  readonly projectIds: ReadonlyArray<ProjectId>;
}

/** A machine may search only the owner context of the drive its token names. */
export const readerSearchScope = (
  userId: string,
  readerDriveId: string,
  contexts: ReadonlyArray<SignalboxContext>,
  drives: ReadonlyArray<SignalboxDrive>,
): ReaderSearchScope | null => {
  const sourceContextId = parseDriveId(readerDriveId)?.contextId;
  if (sourceContextId === undefined) return null;
  const context = contexts.find((candidate) => candidate.id === sourceContextId);
  if (context === undefined || !drives.some((drive) => drive.id === readerDriveId)) return null;

  const ownerDrives = drives.filter((drive) => drive.contextId === sourceContextId);
  return {
    actor: { userId, contextIds: [sourceContextId] },
    drives: ownerDrives,
    projectIds: ownerDrives.map((drive) => drive.projectId),
  };
};

/** Narrow a reader's owner-scoped drives to the requested drive/projects. */
export const limitReaderSearchScope = (
  scope: ReaderSearchScope,
  driveId: string | null,
  projectIds?: ReadonlyArray<ProjectId>,
) => {
  const driveCandidates =
    driveId === null ? scope.drives : scope.drives.filter((drive) => drive.id === driveId);
  if (driveId !== null && driveCandidates.length === 0) return null;
  const allowed = new Set(driveCandidates.map((drive) => drive.projectId));
  const narrowedProjectIds = (projectIds ?? [...allowed]).filter((projectId) =>
    allowed.has(projectId),
  );
  const narrowed = new Set(narrowedProjectIds);
  return {
    drives: driveCandidates.filter((drive) => narrowed.has(drive.projectId)),
    projectIds: narrowedProjectIds,
  };
};

export class ContextTool extends Context.Service<
  ContextTool,
  {
    readonly view: (reader: ContextReader) => Effect.Effect<ContextView, ContextUnavailable>;
    readonly tree: (
      reader: ContextReader,
      request: { readonly driveId: string; readonly commit: Oid; readonly path: string },
    ) => Effect.Effect<TreeResult, ContextAccessError | ContextUnavailable>;
    readonly blob: (
      reader: ContextReader,
      request: { readonly driveId: string; readonly oid: Oid },
    ) => Effect.Effect<BlobResult, ContextAccessError | ContextUnavailable>;
    readonly diff: (
      reader: ContextReader,
      request: { readonly driveId: string; readonly from: Oid | null; readonly to: Oid },
    ) => Effect.Effect<DiffResult, ContextAccessError | ContextUnavailable>;
    readonly search: (
      reader: ContextReader,
      request: SearchRequest,
    ) => Effect.Effect<ContextSearchResult, ContextAccessError | ContextUnavailable>;
    readonly thread: (
      reader: ContextReader,
      request: ThreadRequest,
    ) => Effect.Effect<ThreadResult, ContextAccessError | ContextUnavailable>;
  }
>()("@signalbox/cloud/context/ContextTool") {}

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

const make = Effect.gen(function* () {
  const users = yield* UserDirectory;
  const threads = yield* ThreadDirectory;
  const directory = yield* DriveDirectory;
  const packs = yield* DrivePacks;

  const github = yield* Effect.serviceOption(GitHub);

  /** `driveId`'s reader; a remote-backed drive's promised files come from GitHub as `userId` (#406). */
  const readerOf = (driveId: string, userId: string) =>
    remoteDriveReader(driveId, users.forUser(userId).githubAccessToken()).pipe(
      Effect.provideService(DriveDirectory, directory),
      Effect.provideService(DrivePacks, packs),
      Option.isSome(github) ? Effect.provideService(GitHub, github.value) : (effect) => effect,
    );

  const readableSearchScope = (reader: ContextReader) =>
    Effect.gen(function* () {
      const user = users.forUser(reader.userId);
      const { contexts, drives } = yield* user.readableDrives();
      const currentDrives = yield* Effect.filter(
        drives,
        (drive) => Effect.map(user.driveAccess(drive.id), (role) => role !== null),
        { concurrency: 8 },
      );
      const scope = readerSearchScope(reader.userId, reader.driveId, contexts, currentDrives);
      return scope ?? (yield* new ContextAccessError({ message: NO_ACCESS }));
    });

  const canRead = (reader: ContextReader, driveId: string) =>
    Effect.map(users.forUser(reader.userId).driveAccess(driveId), (role) => role !== null);

  const readable = (reader: ContextReader, driveId: string) =>
    Effect.flatMap(canRead(reader, driveId), (ok) =>
      ok ? Effect.void : Effect.fail(new ContextAccessError({ message: NO_ACCESS })),
    );

  /** The drive's `main` and when it was made, with its shortcuts: what a view pins. */
  const pinned = (driveId: string, path: string | null) =>
    Effect.gen(function* () {
      const handle = directory.forDrive(driveId);
      const commit = yield* handle.ref(MAIN_REF);
      const [stored] = commit === null ? [] : yield* handle.commits([commit]);
      return {
        driveId,
        path,
        commit,
        time: stored?.time ?? null,
        shortcuts: yield* handle.shortcuts(),
      } satisfies ContextDrive;
    });

  const view: ContextTool["Service"]["view"] = (reader) =>
    Effect.gen(function* () {
      const { contexts, drives } = yield* users.forUser(reader.userId).readableDrives();
      // Every context at once: this runs before each turn's harness starts.
      return {
        driveId: reader.driveId,
        contexts: yield* Effect.forEach(
          placeDrives(contexts, drives),
          (placed) =>
            Effect.map(
              Effect.forEach(placed.drives, ({ drive, path }) => pinned(drive.id, path), {
                concurrency: 8,
              }),
              (pinnedDrives) => ({
                contextId: placed.context.id,
                name: placed.name,
                drives: pinnedDrives,
              }),
            ),
          { concurrency: "unbounded" },
        ),
      };
    });

  const tree: ContextTool["Service"]["tree"] = (reader, request) =>
    Effect.gen(function* () {
      yield* readable(reader, request.driveId);
      const segments = pathSegments(request.path);
      if (segments === null) return { _tag: "missing" } as const;
      const drive = yield* readerOf(request.driveId, reader.userId);
      const entry = yield* drive.treeOf(request.commit).pipe(
        Effect.flatMap((root) => drive.entryAt(root, segments)),
        // A commit this drive doesn't have reads as nothing at all.
        Effect.catchTags({ DriveReadError: () => Effect.succeed(null) }),
      );
      if (entry === null || entry.kind === "submodule") return { _tag: "missing" } as const;
      const listed =
        entry.kind === "directory"
          ? yield* drive
              .tree(entry.oid)
              .pipe(Effect.catchTags({ DriveReadError: () => Effect.succeed(null) }))
          : [entry];
      if (listed === null) return { _tag: "missing" } as const;
      const visible = listed.filter((child) => child.kind !== "submodule");
      const blobs = visible.filter((child) => child.kind !== "directory").map((child) => child.oid);
      const sizes = yield* drive.sizes(blobs);
      // A promised file GitHub didn't list a size for (a huge tree) is read to learn it.
      const unknown = [...sizes].flatMap(([oid, size]) => (size === null ? [oid] : []));
      yield* Effect.forEach(
        unknown,
        (oid) =>
          Effect.map(drive.blob(oid).pipe(Effect.option), (read) =>
            read._tag === "Some" ? sizes.set(oid, read.value.length) : sizes.delete(oid),
          ),
        { concurrency: 8, discard: true },
      );
      // A file whose object the drive can't find is left out rather than shown empty.
      const entries = visible.flatMap((child): ReadonlyArray<ContextEntry> => {
        const size = child.kind === "directory" ? 0 : sizes.get(child.oid);
        if (size === undefined || size === null) return [];
        const kind =
          child.kind === "directory" ? "directory" : child.mode === "120000" ? "symlink" : "file";
        return [{ name: child.name, kind, oid: child.oid, size }];
      });
      if (entry.kind === "directory") return { _tag: "directory", entries } as const;
      return entries[0] === undefined
        ? ({ _tag: "missing" } as const)
        : ({ _tag: "file", entry: entries[0] } as const);
    });

  const blob: ContextTool["Service"]["blob"] = (reader, request) =>
    Effect.gen(function* () {
      yield* readable(reader, request.driveId);
      const drive = yield* readerOf(request.driveId, reader.userId);
      const size = (yield* drive.sizes([request.oid])).get(request.oid);
      if (size === undefined) return { _tag: "missing" } as const;
      if (size !== null && size > MAX_CONTEXT_BLOB_BYTES) return { _tag: "too_large" } as const;
      return yield* drive.blob(request.oid).pipe(
        Effect.map((bytes) =>
          bytes.length > MAX_CONTEXT_BLOB_BYTES
            ? ({ _tag: "too_large" } as const)
            : ({ _tag: "blob", bytes } as const),
        ),
        Effect.catchTags({ DriveReadError: () => Effect.succeed({ _tag: "missing" } as const) }),
      );
    });

  const diff: ContextTool["Service"]["diff"] = (reader, request) =>
    Effect.gen(function* () {
      yield* readable(reader, request.driveId);
      const drive = yield* readerOf(request.driveId, reader.userId);
      return yield* drive.diff(request.from, request.to, { ignoreWhitespace: false }).pipe(
        Effect.map((patch): DiffResult => {
          const truncated = patch.length > MAX_PATCH_CHARS;
          return {
            _tag: "diff",
            patch: truncated ? patch.slice(0, MAX_PATCH_CHARS) : patch,
            truncated,
          };
        }),
        Effect.catchTags({ DriveReadError: () => Effect.succeed({ _tag: "missing" } as const) }),
      );
    });

  const thread: ContextTool["Service"]["thread"] = (reader, request) =>
    Effect.gen(function* () {
      const threadId = decodeThreadId(request.threadId);
      if (Option.isNone(threadId)) return { _tag: "not_found" } as const;
      const scope = yield* readableSearchScope(reader);
      if ("itemId" in request) {
        const user = users.forUser(reader.userId);
        const itemScope = limitReaderSearchScope(scope, null, [request.projectId]);
        if (itemScope === null) return { _tag: "not_found" } as const;
        const actor = { ...scope.actor, projectIds: itemScope.projectIds };
        const found = yield* user.readSearchItem(actor, threadId.value, request.itemId);
        const currentScope = yield* readableSearchScope(reader);
        if (!currentScope.projectIds.includes(request.projectId)) {
          return { _tag: "not_found" } as const;
        }
        return found === null ||
          !itemScope.projectIds.includes(found.projectId) ||
          found.projectId !== request.projectId
          ? ({ _tag: "not_found" } as const)
          : ({ _tag: "item", threadId: threadId.value, ...found } as const);
      }
      const found = yield* threads
        .forThread(threadId.value)
        .contextTurns(scope.actor, request.turn);
      if (found === null || !scope.projectIds.includes(found.projectId)) {
        return { _tag: "not_found" } as const;
      }
      const driveId = scope.drives.find((drive) => drive.projectId === found.projectId)?.id ?? null;
      const visible = driveId !== null;
      const [work] = visible
        ? yield* directory.forDrive(driveId).unreconciled({ limit: 1, threadId: request.threadId })
        : [];
      const currentScope = yield* readableSearchScope(reader);
      if (!currentScope.projectIds.includes(found.projectId)) {
        return { _tag: "not_found" } as const;
      }
      return {
        _tag: "thread",
        threadId: request.threadId,
        title: found.title,
        driveId: visible ? driveId : null,
        turns: found.turns,
        unreconciled: work === undefined ? null : { commit: work.commit, base: work.base },
      } as const;
    });

  const search: ContextTool["Service"]["search"] = (reader, request) =>
    Effect.gen(function* () {
      const user = users.forUser(reader.userId);
      const scope = yield* readableSearchScope(reader);
      const requestScope = limitReaderSearchScope(scope, request.driveId, request.projectIds);
      if (requestScope === null) {
        return yield* new ContextAccessError({ message: NO_ACCESS });
      }
      const { driveId: _driveId, projectIds: _projectIds, ...input } = request;
      const searchInput: ThreadSearchInput = { ...input, projectIds: requestScope.projectIds };
      const [threadSearch, driveSearch] = yield* Effect.all(
        [
          user.searchThreads({ ...scope.actor, projectIds: requestScope.projectIds }, searchInput),
          searchDriveHistory({
            reader,
            query: request.query,
            driveIds: requestScope.drives.map((drive) => drive.id),
            workVisible: (threadId, driveId) => {
              const projectId = scope.drives.find((drive) => drive.id === driveId)?.projectId;
              if (projectId === undefined) return Effect.succeed(false);
              return threads.forThread(threadId).contextWorkVisible(scope.actor, projectId);
            },
          }).pipe(
            Effect.provideService(DriveDirectory, directory),
            Effect.provideService(DrivePacks, packs),
          ),
        ],
        { concurrency: "unbounded" },
      );
      const currentScope = yield* readableSearchScope(reader);
      const currentRequestScope = limitReaderSearchScope(
        currentScope,
        request.driveId,
        request.projectIds,
      );
      if (
        currentRequestScope === null ||
        requestScope.projectIds.some(
          (projectId) => !currentRequestScope.projectIds.includes(projectId),
        )
      ) {
        return yield* new ContextAccessError({ message: NO_ACCESS });
      }
      return {
        ...threadSearch,
        driveHits: driveSearch.hits,
        driveSearched: driveSearch.searched,
        driveHitsTruncated: driveSearch.truncated,
      } satisfies ContextSearchResult;
    });

  return ContextTool.of({ view, tree, blob, diff, search, thread });
});

export const layer = Layer.effect(ContextTool, make);
