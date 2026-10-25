import type {
  OrchestrationGetTurnDiffInput,
  ProjectEntry,
  ProjectFileFailure,
  ProjectListEntriesInput,
  ProjectReadFileInput,
  ProjectSearchEntriesInput,
  ReviewDiffFileContentsInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { GitHub } from "../github/GitHub.ts";
import { GitHubConnection } from "../github/GitHubConnection.ts";
import { DriveDirectory } from "../drive/DriveDirectory.ts";
import { DriveFiles } from "../drive/DriveFiles.ts";
import { isWithin, pathSegments } from "../drive/DriveReader.ts";
import type { Shortcut } from "../drive/DriveStore.ts";
import * as CloudThreadService from "../thread/CloudThreadService.ts";
import type { Actor } from "../thread/ThreadEngine.ts";
import { MAIN_REF, threadRef, wipRef } from "../drive/DriveStore.ts";
import { driveOfProject, driveOfRoot, threadWorktreeAt } from "./contextProjects.ts";
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
  const github = yield* Effect.serviceOption(GitHub);
  const connection = yield* Effect.serviceOption(GitHubConnection);

  /** Logs a read failure and answers with what a client should show. */
  const unavailable = (cause: unknown) =>
    Effect.logError("drive read failed", { cause }).pipe(Effect.andThen(Effect.fail(UNAVAILABLE)));

  /**
   * The drive a workspace root names, if the user can open it, with its
   * shortcuts. A thread's working tree in a remote-backed drive (#135) reads
   * that thread's latest save rather than `main`.
   */
  const openRoot = (cwd: string) =>
    Effect.gen(function* () {
      const worktree = threadWorktreeAt(cwd);
      const driveId = worktree?.driveId ?? driveOfRoot(cwd, userId);
      if (files._tag === "None" || directory._tag === "None" || driveId === null) return null;
      if ((yield* drives.access(driveId)) === null) return null;
      const shortcuts = yield* directory.value.forDrive(driveId).shortcuts();
      const refs =
        worktree === null
          ? undefined
          : [wipRef(worktree.threadId), threadRef(worktree.threadId), MAIN_REF];
      /** Which version to read in `at`: the thread's, in its own drive. */
      const versionIn = (at: string) => (at === driveId ? refs : undefined);
      return { driveId, shortcuts, files: files.value, versionIn };
    }).pipe(Effect.catchTags({ SqlError: unavailable, DriveObjectError: unavailable }));

  const listEntries = (request: ProjectListEntriesInput) =>
    Effect.gen(function* () {
      const drive = yield* openRoot(request.cwd);
      if (drive === null) return { entries: [], truncated: false };
      const directoryPath = (pathSegments(request.directoryPath ?? "") ?? []).join("/");
      const at = resolve(drive.driveId, drive.shortcuts, directoryPath);
      const listed = yield* drive.files
        .listEntries(at.driveId, at.path, drive.versionIn(at.driveId))
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
        .readFile(at.driveId, at.path, drive.versionIn(at.driveId))
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

  const diffFileContents = (request: ReviewDiffFileContentsInput) =>
    Effect.gen(function* () {
      const drive = yield* openRoot(request.cwd);
      if (drive === null) return yield* Effect.fail(NO_ACCESS);
      const worktree = threadWorktreeAt(request.cwd);
      if (worktree !== null) {
        const snapshot = yield* threads
          .threadSnapshot(yield* actor, worktree.threadId)
          .pipe(Effect.mapError(() => NO_ACCESS));
        if (driveOfProject(snapshot.projection.thread.projectId, userId) !== drive.driveId) {
          return yield* Effect.fail(NO_ACCESS);
        }
      }
      const remote =
        directory._tag === "Some"
          ? yield* directory.value
              .forDrive(drive.driveId)
              .remote()
              .pipe(Effect.mapError(() => UNAVAILABLE))
          : null;
      if (remote !== null) {
        if (github._tag === "None" || connection._tag === "None")
          return yield* Effect.fail(UNAVAILABLE);
        const token = yield* connection.value.accessToken.pipe(Effect.mapError(() => UNAVAILABLE));
        if (token === null)
          return yield* Effect.fail("Connect GitHub first: Settings › Source Control.");
        // Cached immutable blobs still require the reader's current repository access.
        const repository = yield* github.value.api
          .repository(token, remote.repository)
          .pipe(Effect.mapError(() => UNAVAILABLE));
        if (repository === null) return yield* Effect.fail(NO_ACCESS);
      }
      return yield* drive.files.diffFileContents(drive.driveId, request).pipe(
        Effect.catchTags({
          DriveReadError: (error) => Effect.fail(error.message),
          DriveObjectError: unavailable,
          DrivePackError: unavailable,
        }),
      );
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
        .searchEntries(drive.driveId, query, drive.versionIn(drive.driveId))
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

  return { listEntries, readFile, diffFileContents, searchEntries, turnDiff };
});
