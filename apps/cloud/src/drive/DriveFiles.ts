import type {
  OrchestrationV2Checkpoint,
  ProjectEntry,
  ReviewDiffFileContentsInput,
  ReviewDiffFileContentsResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { parseCheckpointRange } from "../thread/driveEvents.ts";
import { DriveDirectory } from "./DriveDirectory.ts";
import { DrivePacks } from "./DrivePacks.ts";
import { type DriveReader, DriveReadError, makeDriveReader, pathSegments } from "./DriveReader.ts";
import { MAIN_REF } from "./DriveStore.ts";
import { remoteDriveReader } from "./remoteFiles.ts";
import { GitHub } from "../github/GitHub.ts";
import { GitHubConnection } from "../github/GitHubConnection.ts";
import { isBinary } from "./drivePatch.ts";
import type { Oid } from "./git/gitObjects.ts";

/**
 * A drive as clients browse it, with no machine running: the files on its
 * `main` (what every thread has reconciled), and each turn's changes as a diff
 * between the commits its checkpoint names. The shapes are the environment
 * protocol's own, so the files panel, file search and diff panel work
 * unchanged. A remote-backed drive's promised files come from GitHub with the
 * user's own connection (#406).
 */

/** Files above this are returned cut off, like a self-hosted server does. */
const MAX_FILE_BYTES = 1024 * 1024;
/** Files above this are not read at all: inflating one would crowd the object's memory. */
const MAX_READ_BYTES = 8 * 1024 * 1024;
/** Most entries a search walks; a drive bigger than this searches its first part. */
const MAX_SEARCH_ENTRIES = 25_000;

/** Which version to read: the first of these refs that exists. Defaults to `main`. */
export type ReadAt = ReadonlyArray<string>;

export type DriveFile =
  | {
      readonly _tag: "file";
      readonly contents: string;
      readonly byteLength: number;
      readonly truncated: boolean;
    }
  | { readonly _tag: "not_file" | "binary" | "missing" | "outside" | "too_large" };

type Failure = Effect.Error<ReturnType<DriveReader["object"]>>;

export class DriveFiles extends Context.Service<
  DriveFiles,
  {
    readonly listEntries: (
      driveId: string,
      directoryPath: string,
      at?: ReadAt,
    ) => Effect.Effect<ReadonlyArray<ProjectEntry>, Failure>;
    readonly readFile: (
      driveId: string,
      path: string,
      at?: ReadAt,
    ) => Effect.Effect<DriveFile, Failure>;
    readonly diffFileContents: (
      driveId: string,
      input: ReviewDiffFileContentsInput,
    ) => Effect.Effect<ReviewDiffFileContentsResult, Failure>;
    readonly searchEntries: (
      driveId: string,
      input: {
        readonly query: string;
        readonly limit: number;
        readonly kind?: ProjectEntry["kind"];
      },
      at?: ReadAt,
    ) => Effect.Effect<
      { readonly entries: ReadonlyArray<ProjectEntry>; readonly truncated: boolean },
      Failure
    >;
    /**
     * The diff over turns `from` (exclusive) to `to` (inclusive): from where the
     * first checkpointed turn after `from` started to where turn `to` ended.
     */
    readonly turnDiff: (
      driveId: string,
      checkpoints: ReadonlyArray<OrchestrationV2Checkpoint>,
      range: { readonly from: number; readonly to: number; readonly ignoreWhitespace: boolean },
    ) => Effect.Effect<string, Failure>;
  }
>()("@signalbox/cloud/drive/DriveFiles") {}

/** Search order: names that start with the query, then paths that contain it. */
const rank = (path: string, query: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (name.startsWith(query)) return 0;
  if (name.includes(query)) return 1;
  return path.toLowerCase().includes(query) ? 2 : null;
};

const make = Effect.gen(function* () {
  const directory = yield* DriveDirectory;
  const packs = yield* DrivePacks;
  const github = yield* Effect.serviceOption(GitHub);
  const connection = yield* Effect.serviceOption(GitHubConnection);
  // The user's own GitHub connection reads their remote-backed drives' promised files.
  const readerOf = (driveId: string) =>
    (Option.isSome(github) && Option.isSome(connection)
      ? remoteDriveReader(driveId, connection.value.accessToken).pipe(
          Effect.provideService(GitHub, github.value),
        )
      : makeDriveReader(driveId)
    ).pipe(
      Effect.provideService(DriveDirectory, directory),
      Effect.provideService(DrivePacks, packs),
    );
  const resolveAt = (reader: DriveReader, at: ReadAt = [MAIN_REF]) =>
    Effect.gen(function* () {
      for (const name of at) {
        const oid = yield* reader.drive.ref(name);
        if (oid !== null) return oid;
      }
      return null;
    });

  /** Every path on each drive's latest searched commit: searches run per keystroke. */
  const walked = new Map<
    string,
    {
      readonly commit: Oid;
      readonly entries: ReadonlyArray<ProjectEntry>;
      readonly truncated: boolean;
    }
  >();
  const allEntries = (driveId: string, reader: DriveReader, commit: Oid) =>
    Effect.gen(function* () {
      const cached = walked.get(driveId);
      if (cached?.commit === commit) return cached;
      const result = yield* reader.files(yield* reader.treeOf(commit), MAX_SEARCH_ENTRIES);
      const entry = { commit, ...result };
      walked.set(driveId, entry);
      return entry;
    });

  const listEntries: DriveFiles["Service"]["listEntries"] = (driveId, directoryPath, at) =>
    Effect.gen(function* () {
      const reader = yield* readerOf(driveId);
      const main = yield* resolveAt(reader, at);
      const segments = pathSegments(directoryPath);
      if (main === null || segments === null) return [];
      const entry = yield* reader.entryAt(yield* reader.treeOf(main), segments);
      if (entry === null || entry.kind !== "directory") return [];
      const prefix = segments.length === 0 ? "" : `${segments.join("/")}/`;
      return (yield* reader.tree(entry.oid))
        .filter((child) => child.kind !== "submodule")
        .map((child) => ({
          path: `${prefix}${child.name}`,
          kind: child.kind === "directory" ? ("directory" as const) : ("file" as const),
        }));
    });

  const readFile: DriveFiles["Service"]["readFile"] = (driveId, path, at) =>
    Effect.gen(function* () {
      const segments = pathSegments(path);
      if (segments === null || segments.length === 0) return { _tag: "outside" } as const;
      const reader = yield* readerOf(driveId);
      const main = yield* resolveAt(reader, at);
      if (main === null) return { _tag: "missing" } as const;
      const entry = yield* reader.entryAt(yield* reader.treeOf(main), segments);
      if (entry === null) return { _tag: "missing" } as const;
      if (entry.kind === "directory" || entry.kind === "submodule")
        return { _tag: "not_file" } as const;
      // Only the start is shown, so a file too big to show whole is not read at all.
      const size = (yield* reader.sizes([entry.oid])).get(entry.oid);
      if (size !== undefined && size !== null && size > MAX_READ_BYTES)
        return { _tag: "too_large" } as const;
      const found = yield* reader.object(entry.oid);
      if (found.type !== "blob") return { _tag: "not_file" } as const;
      if (isBinary(found.content)) return { _tag: "binary" } as const;
      const truncated = found.content.length > MAX_FILE_BYTES;
      return {
        _tag: "file",
        contents: new TextDecoder().decode(
          truncated ? found.content.subarray(0, MAX_FILE_BYTES) : found.content,
        ),
        byteLength: found.content.length,
        truncated,
      } as const;
    });

  const diffFileContents: DriveFiles["Service"]["diffFileContents"] = (driveId, input) =>
    Effect.gen(function* () {
      const reader = yield* readerOf(driveId);
      const side = (revision: string | null, path: string) =>
        Effect.gen(function* () {
          const fail = (message: string) => new DriveReadError({ message });
          if (revision === null || !/^[a-f0-9]{40}$/.test(revision)) {
            return yield* fail(
              "Diff expansion requires an immutable commit ID for each existing side.",
            );
          }
          if ((yield* reader.drive.missing([revision], null)).length > 0) {
            return yield* fail("The requested revision is not available in this drive.");
          }
          const segments = pathSegments(path);
          if (segments === null || segments.length === 0) {
            return yield* fail(`Diff file '${path}' resolves outside the review workspace.`);
          }
          const entry = yield* reader.entryAt(yield* reader.treeOf(revision), segments);
          if (entry === null)
            return yield* fail(`Diff file '${path}' does not exist at ${revision}.`);
          if (entry.kind === "directory" || entry.kind === "submodule") {
            return yield* fail(`Diff path '${path}' is not a file.`);
          }
          const size = (yield* reader.sizes([entry.oid])).get(entry.oid);
          if (size !== undefined && size !== null && size > MAX_FILE_BYTES) {
            return yield* fail(`Diff file '${path}' exceeds the 1 MB expansion limit.`);
          }
          const bytes = yield* reader.blob(entry.oid);
          if (bytes.length > MAX_FILE_BYTES) {
            return yield* fail(`Diff file '${path}' exceeds the 1 MB expansion limit.`);
          }
          if (bytes.includes(0)) return yield* fail(`Cannot expand binary file '${path}'.`);
          return new TextDecoder().decode(bytes);
        });
      const [oldContents, newContents] = yield* Effect.all(
        [
          input.changeType === "new" ? Effect.succeed("") : side(input.baseRef, input.oldPath),
          input.changeType === "deleted" ? Effect.succeed("") : side(input.headRef, input.newPath),
        ],
        { concurrency: 2 },
      );
      return { oldContents, newContents };
    });

  const searchEntries: DriveFiles["Service"]["searchEntries"] = (driveId, input, at) =>
    Effect.gen(function* () {
      const reader = yield* readerOf(driveId);
      const main = yield* resolveAt(reader, at);
      if (main === null) return { entries: [], truncated: false };
      const all = yield* allEntries(driveId, reader, main);
      const query = input.query.trim().toLowerCase();
      const matches = all.entries
        .filter((entry) => input.kind === undefined || entry.kind === input.kind)
        .map((entry) => ({ entry, rank: query === "" ? 0 : rank(entry.path, query) }))
        .filter((candidate) => candidate.rank !== null)
        .sort(
          (left, right) =>
            left.rank! - right.rank! || left.entry.path.length - right.entry.path.length,
        );
      return {
        entries: matches.slice(0, input.limit).map((candidate) => candidate.entry),
        truncated: all.truncated || matches.length > input.limit,
      };
    });

  const turnDiff: DriveFiles["Service"]["turnDiff"] = (driveId, checkpoints, range) =>
    Effect.gen(function* () {
      if (range.from >= range.to) return "";
      const turns = checkpoints
        .filter((checkpoint) => checkpoint.status === "ready" && checkpoint.appRunOrdinal !== null)
        .map((checkpoint) => ({
          turn: checkpoint.appRunOrdinal!,
          range: parseCheckpointRange(checkpoint.ref),
        }))
        .filter((candidate) => candidate.range !== null)
        .sort((left, right) => left.turn - right.turn);
      const first = turns.find((candidate) => candidate.turn > range.from);
      const last = turns.find((candidate) => candidate.turn === range.to);
      if (first === undefined || last === undefined) {
        return yield* new DriveReadError({ message: `Turn ${range.to} has no saved files.` });
      }
      const reader = yield* readerOf(driveId);
      return yield* reader.diff(first.range!.start, last.range!.commit, {
        ignoreWhitespace: range.ignoreWhitespace,
      });
    });

  return DriveFiles.of({ listEntries, readFile, diffFileContents, searchEntries, turnDiff });
});

export const layer = Layer.effect(DriveFiles, make);
