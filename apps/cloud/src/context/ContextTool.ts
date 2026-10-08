import {
  type ContextDrive,
  type ContextEntry,
  type ContextView,
  type DiffResult,
  MAX_CONTEXT_BLOB_BYTES,
  type SearchResult,
  type ThreadResult,
  type TreeResult,
} from "@signalbox/runner-protocol/ContextProtocol";
import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { DriveDirectory, type DriveObjectError } from "../drive/DriveDirectory.ts";
import { type DrivePackError, DrivePacks } from "../drive/DrivePacks.ts";
import { makeDriveReader, pathSegments } from "../drive/DriveReader.ts";
import { MAIN_REF } from "../drive/DriveStore.ts";
import type { Bytes, Oid } from "../drive/git/gitObjects.ts";
import { ThreadDirectory, type ThreadObjectError } from "../thread/ThreadDirectory.ts";
import type { Actor } from "../thread/ThreadEngine.ts";
import { driveOfProject } from "../user/contextProjects.ts";
import { UserDirectory, type UserObjectError } from "../user/UserDirectory.ts";
import { searchContext } from "./contextSearch.ts";
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
      request: { readonly query: string; readonly driveId: string | null },
    ) => Effect.Effect<SearchResult, ContextAccessError | ContextUnavailable>;
    readonly thread: (
      reader: ContextReader,
      request: { readonly threadId: string; readonly turn: number | null },
    ) => Effect.Effect<ThreadResult, ContextUnavailable>;
  }
>()("@signalbox/cloud/context/ContextTool") {}

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

const make = Effect.gen(function* () {
  const users = yield* UserDirectory;
  const threads = yield* ThreadDirectory;
  const directory = yield* DriveDirectory;
  const packs = yield* DrivePacks;

  const readerOf = (driveId: string) =>
    makeDriveReader(driveId).pipe(
      Effect.provideService(DriveDirectory, directory),
      Effect.provideService(DrivePacks, packs),
    );

  const actorOf = (reader: ContextReader) =>
    Effect.map(users.forUser(reader.userId).contextIds(), (contextIds): Actor => ({
      userId: reader.userId,
      contextIds,
    }));

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
      const drive = yield* readerOf(request.driveId);
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
      const sizes = new Map(
        (blobs.length === 0 ? [] : yield* drive.drive.locate(blobs)).map((found) => [
          found.oid,
          found.size,
        ]),
      );
      // A file whose object the drive can't find is left out rather than shown empty.
      const entries = visible.flatMap((child): ReadonlyArray<ContextEntry> => {
        const size = child.kind === "directory" ? 0 : sizes.get(child.oid);
        if (size === undefined) return [];
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
      const drive = yield* readerOf(request.driveId);
      const [location] = yield* drive.drive.locate([request.oid]);
      if (location === undefined || location.type !== "blob") return { _tag: "missing" } as const;
      if (location.size > MAX_CONTEXT_BLOB_BYTES) return { _tag: "too_large" } as const;
      return yield* drive.object(request.oid).pipe(
        Effect.map((found) => ({ _tag: "blob", bytes: found.content }) as const),
        Effect.catchTags({ DriveReadError: () => Effect.succeed({ _tag: "missing" } as const) }),
      );
    });

  const diff: ContextTool["Service"]["diff"] = (reader, request) =>
    Effect.gen(function* () {
      yield* readable(reader, request.driveId);
      const drive = yield* readerOf(request.driveId);
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
      const found = yield* threads
        .forThread(threadId.value)
        .contextTurns(yield* actorOf(reader), request.turn);
      if (found === null) return { _tag: "not_found" } as const;
      const driveId = driveOfProject(found.projectId, reader.userId);
      const visible = driveId !== null && (yield* canRead(reader, driveId));
      const [work] = visible
        ? yield* directory.forDrive(driveId).unreconciled({ limit: 1, threadId: request.threadId })
        : [];
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
      const scope =
        request.driveId === null
          ? Effect.map(user.readableDrives(), ({ contexts, drives }) => ({
              contextIds: contexts.map((context) => context.id),
              driveIds: drives.map((drive) => drive.id as string),
            }))
          : Effect.map(
              Effect.all([readable(reader, request.driveId), user.contextIds()], {
                concurrency: "unbounded",
              }),
              ([, contextIds]) => ({ contextIds, driveIds: [request.driveId!] }),
            );
      const [{ contextIds, driveIds }, shell] = yield* Effect.all([scope, user.shellSnapshot()], {
        concurrency: "unbounded",
      });
      return yield* searchContext({
        reader,
        actor: { userId: reader.userId, contextIds },
        query: request.query,
        driveIds,
        shell,
      }).pipe(
        Effect.provideService(ThreadDirectory, threads),
        Effect.provideService(DriveDirectory, directory),
        Effect.provideService(DrivePacks, packs),
      );
    });

  return ContextTool.of({ view, tree, blob, diff, search, thread });
});

export const layer = Layer.effect(ContextTool, make);
