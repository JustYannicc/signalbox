import type {
  OrchestrationGetTurnDiffInput,
  ProjectFileFailure,
  ProjectListEntriesInput,
  ProjectReadFileInput,
  ProjectSearchEntriesInput,
  ReviewDiffPreviewInput,
} from "@t3tools/contracts";
import type { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { myDriveId, projectDriveId } from "../drive/DriveDirectory.ts";
import { MAIN_REF, threadRef, wipRef } from "../drive/DriveStore.ts";
import { DriveFiles } from "../drive/DriveFiles.ts";
import * as CloudThreadService from "../thread/CloudThreadService.ts";
import type { Actor } from "../thread/ThreadEngine.ts";
import { contextOfProject, contextProjects, remoteProjectAt } from "./contextProjects.ts";
import * as UserContexts from "./UserContexts.ts";

/**
 * The environment protocol's file and diff calls, answered from the acting
 * user's drives. A project's `cwd` is its workspace root, which names the
 * context, and so the user's My Drive in it; a thread's diffs come from the
 * drive of the context it acts in. Without drives every listing is empty.
 */

const NO_DRIVE = "Files live in drives, which this cloud does not store.";
const UNAVAILABLE = "The drive is unavailable right now. Try again.";

export const makeDriveBrowsing = Effect.fn("makeDriveBrowsing")(function* (actor: Actor) {
  const contexts = yield* UserContexts.UserContexts;
  const threads = yield* CloudThreadService.CloudThreadService;
  const files = yield* Effect.serviceOption(DriveFiles);

  const driveOf = (contextId: SignalboxContextId | null) =>
    contextId === null ? null : myDriveId(contextId, actor.userId);

  /**
   * The drive a project root names, or null when it names none of the user's.
   * A thread's working tree in an imported repository reads that thread's
   * latest save, falling back to the repository's default branch.
   */
  const driveForCwd = (cwd: string) =>
    Effect.gen(function* () {
      const current = yield* contexts.contexts;
      const remote = remoteProjectAt(yield* contexts.remoteProjects, cwd);
      if (remote !== null) {
        return {
          driveId: projectDriveId(actor.userId, remote.project.projectId),
          at:
            remote.threadId === null
              ? [MAIN_REF]
              : [wipRef(remote.threadId), threadRef(remote.threadId), MAIN_REF],
        };
      }
      const project = contextProjects(current).find((candidate) => candidate.workspaceRoot === cwd);
      const driveId = driveOf(project === undefined ? null : contextOfProject(current, project.id));
      return driveId === null ? null : { driveId, at: [MAIN_REF] };
    }).pipe(Effect.orDie);

  /** Logs a read failure and answers with what a client should show. */
  const unavailable = (cause: unknown) =>
    Effect.logError("drive read failed", { cause }).pipe(Effect.andThen(Effect.fail(UNAVAILABLE)));

  const listEntries = (request: ProjectListEntriesInput) =>
    Effect.gen(function* () {
      const drive = yield* driveForCwd(request.cwd);
      if (files._tag === "None" || drive === null) return { entries: [], truncated: false };
      const entries = yield* files.value
        .listEntries(drive.driveId, request.directoryPath ?? "", drive.at)
        .pipe(Effect.catch(unavailable));
      return { entries, truncated: false };
    });

  const readFile = (request: ProjectReadFileInput) =>
    Effect.gen(function* () {
      // Clients act on `failure` (a folder is `path_not_file`); the message is the contract's own.
      const fail = (failure: ProjectFileFailure) => Effect.fail({ failure });
      const drive = yield* driveForCwd(request.cwd);
      if (files._tag === "None" || drive === null) return yield* fail("operation_failed");
      const file = yield* files.value
        .readFile(drive.driveId, request.relativePath, drive.at)
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
      const drive = yield* driveForCwd(request.cwd);
      if (files._tag === "None" || drive === null) return { entries: [], truncated: false };
      return yield* files.value
        .searchEntries(
          drive.driveId,
          {
            query: request.query,
            limit: request.limit,
            ...(request.kind === undefined ? {} : { kind: request.kind }),
          },
          drive.at,
        )
        .pipe(Effect.catch(unavailable));
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
        .threadSnapshot(actor, request.threadId)
        .pipe(Effect.mapError(() => "Thread not found."));
      const { projection } = snapshot;
      const current = yield* Effect.orDie(contexts.contexts);
      const projectId = projection.thread.projectId;
      const imported = (yield* Effect.orDie(contexts.remoteProjects)).some(
        (project) => project.projectId === projectId,
      );
      const driveId = imported
        ? projectDriveId(actor.userId, projectId)
        : driveOf(contextOfProject(current, projectId));
      if (files._tag === "None" || driveId === null) return yield* Effect.fail(NO_DRIVE);
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
