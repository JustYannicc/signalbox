import type {
  OrchestrationGetTurnDiffInput,
  ProjectEntry,
  ProjectFileFailure,
  ProjectListEntriesInput,
  ProjectReadFileInput,
  ProjectSearchEntriesInput,
  ReviewDiffPreviewInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { DriveDirectory } from "../drive/DriveDirectory.ts";
import { DriveFiles } from "../drive/DriveFiles.ts";
import { isWithin, pathSegments } from "../drive/DriveReader.ts";
import type { Shortcut } from "../drive/DriveStore.ts";
import * as CloudThreadService from "../thread/CloudThreadService.ts";
import type { Actor } from "../thread/ThreadEngine.ts";
import { driveOfProject, driveOfRoot } from "./contextProjects.ts";
import * as UserDrives from "./UserDrives.ts";

/**
 * The environment protocol's file and diff calls, answered from the drives
 * the acting user can open. A project's `cwd` is its workspace root, which
 * names its drive; a thread's diffs come from the drive it works in. Every
 * call asks the user's access first, so a removed member reads nothing more.
 *
 * A folder split out of a My Drive to be shared stays at its path as a
 * shortcut, and reads under it come from the folder's own drive, so its owner
 * sees no difference. Without drives every listing is empty.
 */

const NO_DRIVE = "Files live in drives, which this cloud does not store.";
const NO_ACCESS = "You don't have access to this drive's files.";
const UNAVAILABLE = "The drive is unavailable right now. Try again.";

/** Where a path of a drive really is: in the drive itself, or in a shortcut's drive. */
const resolve = (driveId: string, shortcuts: ReadonlyArray<Shortcut>, requested: string) => {
  const path = (pathSegments(requested) ?? []).join("/");
  const shortcut = shortcuts.find((candidate) => isWithin(path, candidate.path));
  return shortcut === undefined
    ? { driveId, path, prefix: "" }
    : {
        driveId: shortcut.target,
        path: path.slice(shortcut.path.length + 1),
        prefix: `${shortcut.path}/`,
      };
};

const withPrefix = (prefix: string, entries: ReadonlyArray<ProjectEntry>) =>
  prefix === "" ? entries : entries.map((entry) => ({ ...entry, path: `${prefix}${entry.path}` }));

/** `actor`: who is acting, as of each call. */
export const makeDriveBrowsing = Effect.fn("makeDriveBrowsing")(function* (
  userId: string,
  actor: Effect.Effect<Actor>,
) {
  const drives = yield* UserDrives.UserDrives;
  const threads = yield* CloudThreadService.CloudThreadService;
  const files = yield* Effect.serviceOption(DriveFiles);
  const directory = yield* Effect.serviceOption(DriveDirectory);

  /** Logs a read failure and answers with what a client should show. */
  const unavailable = (cause: unknown) =>
    Effect.logError("drive read failed", { cause }).pipe(Effect.andThen(Effect.fail(UNAVAILABLE)));

  /** The drive a workspace root names, if the user can open it, with its shortcuts. */
  const openRoot = (cwd: string) =>
    Effect.gen(function* () {
      const driveId = driveOfRoot(cwd, userId);
      if (files._tag === "None" || directory._tag === "None" || driveId === null) return null;
      if ((yield* drives.access(driveId)) === null) return null;
      const shortcuts = yield* directory.value.forDrive(driveId).shortcuts();
      return { driveId, shortcuts, files: files.value };
    }).pipe(Effect.catchTags({ SqlError: unavailable, DriveObjectError: unavailable }));

  const listEntries = (request: ProjectListEntriesInput) =>
    Effect.gen(function* () {
      const drive = yield* openRoot(request.cwd);
      if (drive === null) return { entries: [], truncated: false };
      const directoryPath = (pathSegments(request.directoryPath ?? "") ?? []).join("/");
      const at = resolve(drive.driveId, drive.shortcuts, directoryPath);
      const listed = yield* drive.files
        .listEntries(at.driveId, at.path)
        .pipe(Effect.catch(unavailable));
      const entries = withPrefix(at.prefix, listed);
      if (at.prefix !== "") return { entries, truncated: false };
      // A shortcut shows as the folder it replaced.
      const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
      const shortcutEntries = drive.shortcuts
        .filter((shortcut) => parentOf(shortcut.path) === directoryPath)
        .filter((shortcut) => !entries.some((entry) => entry.path === shortcut.path))
        .map((shortcut): ProjectEntry => ({ path: shortcut.path, kind: "directory" }));
      return { entries: [...entries, ...shortcutEntries], truncated: false };
    });

  const readFile = (request: ProjectReadFileInput) =>
    Effect.gen(function* () {
      // Clients act on `failure` (a folder is `path_not_file`); the message is the contract's own.
      const fail = (failure: ProjectFileFailure) => Effect.fail({ failure });
      const drive = yield* openRoot(request.cwd).pipe(Effect.catch(() => Effect.succeed(null)));
      if (drive === null) return yield* fail("operation_failed");
      const at = resolve(drive.driveId, drive.shortcuts, request.relativePath);
      if (at.path === "") return yield* fail("path_not_file");
      const file = yield* drive.files
        .readFile(at.driveId, at.path)
        .pipe(
          Effect.catch((cause) =>
            Effect.flatMap(Effect.ignore(unavailable(cause)), () => fail("operation_failed")),
          ),
        );
      switch (file._tag) {
        case "file":
          return {
            relativePath: request.relativePath,
            contents: file.contents,
            byteLength: file.byteLength,
            truncated: file.truncated,
          };
        case "not_file":
          return yield* fail("path_not_file");
        case "binary":
          return yield* fail("binary_file");
        case "outside":
          return yield* fail("workspace_path_outside_root");
        case "missing":
        case "too_large":
          return yield* fail("operation_failed");
      }
    });

  const searchEntries = (request: ProjectSearchEntriesInput) =>
    Effect.gen(function* () {
      const drive = yield* openRoot(request.cwd);
      if (drive === null) return { entries: [], truncated: false };
      const query = {
        query: request.query,
        limit: request.limit,
        ...(request.kind === undefined ? {} : { kind: request.kind }),
      };
      const own = yield* drive.files
        .searchEntries(drive.driveId, query)
        .pipe(Effect.catch(unavailable));
      // The drive's own matches come first; shortcuts fill what's left of the limit.
      const shortcuts =
        own.entries.length >= request.limit
          ? []
          : yield* Effect.forEach(
              drive.shortcuts,
              (shortcut) =>
                drive.files.searchEntries(shortcut.target, query).pipe(
                  Effect.map((found) => ({
                    entries: withPrefix(`${shortcut.path}/`, found.entries),
                    truncated: found.truncated,
                  })),
                  Effect.catch(unavailable),
                ),
              { concurrency: 4 },
            );
      const entries = [own, ...shortcuts].flatMap((found) => found.entries);
      return {
        entries: entries.slice(0, request.limit),
        truncated: entries.length > request.limit || [own, ...shortcuts].some((f) => f.truncated),
      };
    });

  /** A drive has no uncommitted changes to preview: every turn's work is in its diff. */
  const reviewPreview = (request: ReviewDiffPreviewInput) =>
    Effect.map(Clock.currentTimeMillis, (now) => ({
      cwd: request.cwd,
      generatedAt: DateTime.makeUnsafe(now),
      sources: [],
    }));

  const turnDiff = (request: OrchestrationGetTurnDiffInput) =>
    Effect.gen(function* () {
      const snapshot = yield* threads
        .threadSnapshot(yield* actor, request.threadId)
        .pipe(Effect.mapError(() => "Thread not found."));
      const { projection } = snapshot;
      const driveId = driveOfProject(projection.thread.projectId, userId);
      if (files._tag === "None" || driveId === null) return yield* Effect.fail(NO_DRIVE);
      const role = yield* drives
        .access(driveId)
        .pipe(Effect.catchTags({ SqlError: unavailable, DriveObjectError: unavailable }));
      if (role === null) return yield* Effect.fail(NO_ACCESS);
      const diff = yield* files.value
        .turnDiff(driveId, projection.checkpoints, {
          from: request.fromTurnCount,
          to: request.toTurnCount,
          ignoreWhitespace: request.ignoreWhitespace ?? true,
        })
        .pipe(
          Effect.catchTags({
            DriveReadError: (error) => Effect.fail(error.message),
            DriveObjectError: unavailable,
            DrivePackError: unavailable,
          }),
        );
      return {
        threadId: request.threadId,
        fromTurnCount: request.fromTurnCount,
        toTurnCount: request.toTurnCount,
        diff,
      };
    });

  return { listEntries, readFile, searchEntries, reviewPreview, turnDiff };
});
