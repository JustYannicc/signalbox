import type { ProjectSearchContentsInput, ProjectSearchContentsResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { DriveDirectory } from "../drive/DriveDirectory.ts";
import { DriveFiles } from "../drive/DriveFiles.ts";
import { parseDriveId } from "../drive/driveAccess.ts";
import { DriveReadError } from "../drive/DriveReader.ts";
import { MAIN_REF, threadRef, wipRef } from "../drive/DriveStore.ts";
import { GitHub } from "../github/GitHub.ts";
import { GitHubConnection } from "../github/GitHubConnection.ts";
import { CloudThreadService } from "../thread/CloudThreadService.ts";
import type { Actor } from "../thread/ThreadEngine.ts";
import { driveOfProject, driveOfRoot, threadWorktreeAt } from "./contextProjects.ts";
import {
  makeContentSearchCursors,
  type ContentSearchCursor,
  type ContentSearchSource,
} from "./contentSearchCursor.ts";
import { UserDrives } from "./UserDrives.ts";
import { UserFolders } from "./UserFolders.ts";

const DENIED = "You don't have access to this folder's files.";
const EXPIRED = "This search expired or changed. Start a new search.";
const isReadError = Schema.is(DriveReadError);
const fingerprintOf = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Tuple([
      Schema.String,
      Schema.String,
      Schema.Number,
      Schema.Boolean,
      Schema.Boolean,
      Schema.Boolean,
    ]),
  ),
);

/** Authorization and durable continuation around the shared drive scanner. No runner participates. */
export const makeDriveContentSearch = Effect.fn("makeDriveContentSearch")(function* (
  userId: string,
  actorNow: Effect.Effect<Actor>,
) {
  const files = yield* Effect.serviceOption(DriveFiles);
  const directory = yield* Effect.serviceOption(DriveDirectory);
  const drives = yield* UserDrives;
  const folders = yield* UserFolders;
  const threads = yield* CloudThreadService;
  const github = yield* Effect.serviceOption(GitHub);
  const connection = yield* Effect.serviceOption(GitHubConnection);
  const cursors = yield* makeContentSearchCursors;

  const allowed = (driveId: string) =>
    Effect.gen(function* () {
      const actor = yield* actorNow;
      const contextId = parseDriveId(driveId)?.contextId;
      if (
        actor.userId !== userId ||
        contextId === undefined ||
        !actor.contextIds.includes(contextId)
      )
        return false;
      if ((yield* drives.access(driveId)) === null || (yield* folders.driveIsTrashed(driveId)))
        return false;
      if (Option.isNone(directory)) return false;
      const remote = yield* directory.value.forDrive(driveId).remote();
      if (remote === null) return true;
      // Immutable object caches never replace current access to a remote source.
      if (Option.isNone(github) || Option.isNone(connection)) return false;
      const token = yield* connection.value.accessToken;
      return (
        token !== null && (yield* github.value.api.repository(token, remote.repository)) !== null
      );
    });

  const sourceAllowed = (source: ContentSearchSource) =>
    Effect.gen(function* () {
      if (!(yield* allowed(source.driveId)) || Option.isNone(directory)) return false;
      for (const edge of source.route) {
        if (!(yield* allowed(edge.from))) return false;
        const links = yield* directory.value.forDrive(edge.from).shortcuts();
        if (!links.some((link) => link.path === edge.path && link.target === edge.target))
          return false;
      }
      return true;
    });

  return (input: ProjectSearchContentsInput): Effect.Effect<ProjectSearchContentsResult, string> =>
    Effect.gen(function* () {
      if (Option.isNone(files) || Option.isNone(directory))
        return yield* Effect.fail("Files are unavailable in this cloud.");
      const worktree = threadWorktreeAt(input.cwd);
      const root = worktree?.driveId ?? driveOfRoot(input.cwd, userId);
      if (root === null || !(yield* allowed(root))) return yield* Effect.fail(DENIED);
      if (worktree !== null) {
        const snapshot = yield* threads.threadSnapshot(yield* actorNow, worktree.threadId);
        if (driveOfProject(snapshot.projection.thread.projectId, userId) !== root)
          return yield* Effect.fail(DENIED);
      }
      const fingerprint = fingerprintOf([
        input.cwd,
        input.query,
        input.limit,
        input.caseSensitive,
        input.wholeWord,
        input.useRegex,
      ]);
      const saved = input.cursor === undefined ? null : yield* cursors.read(input.cursor);
      if (
        input.cursor !== undefined &&
        (saved === null || saved.fingerprint !== fingerprint || saved.root !== root)
      )
        return yield* Effect.fail(EXPIRED);
      let state: ContentSearchCursor = saved ?? {
        fingerprint,
        root,
        sources: [{ driveId: root, prefix: "", route: [] }],
        seen: [root],
        truncated: false,
      };
      const source = state.sources[0];
      if (source === undefined) return { matches: [], truncated: state.truncated };
      if (!(yield* sourceAllowed(source))) {
        state = { ...state, sources: state.sources.slice(1), current: undefined };
        return {
          matches: [],
          truncated: state.sources.length > 0 || state.truncated,
          ...(state.sources.length > 0 ? { nextCursor: yield* cursors.save(state) } : {}),
        };
      }
      if (state.current === undefined) {
        const shortcuts = yield* directory.value.forDrive(source.driveId).shortcuts();
        const seen = new Set(state.seen);
        const added: Array<ContentSearchSource> = [];
        for (const link of shortcuts.toSorted((a, b) => a.path.localeCompare(b.path))) {
          if (seen.has(link.target)) continue;
          seen.add(link.target);
          added.push({
            driveId: link.target,
            prefix: `${source.prefix}${link.path}/`,
            route: [
              ...source.route,
              { from: source.driveId, path: link.path, target: link.target },
            ],
          });
        }
        const at =
          source.driveId === root && worktree !== null
            ? [wipRef(worktree.threadId), threadRef(worktree.threadId), MAIN_REF]
            : undefined;
        state = {
          ...state,
          seen: [...seen],
          sources: [...state.sources, ...added],
          current: {
            commit: yield* files.value.contentSearchSnapshot(source.driveId, at),
            excluded: shortcuts.map((link) => link.path),
            links: shortcuts.map(({ path, target }) => ({ path, target })),
          },
        };
      }
      const current = state.current!;
      const result = yield* files.value.searchContents(
        source.driveId,
        input,
        current.commit,
        current.scan,
        current.excluded,
      );
      // Membership or the reference route may have changed while R2/GitHub was being read.
      if (!(yield* allowed(root)) || !(yield* sourceAllowed(source)))
        return yield* Effect.fail(DENIED);
      const nowShortcuts = yield* directory.value.forDrive(source.driveId).shortcuts();
      if (
        nowShortcuts.length !== current.links.length ||
        nowShortcuts.some(
          (link) =>
            !current.links.some(
              (previous) => previous.path === link.path && previous.target === link.target,
            ),
        )
      )
        return yield* Effect.fail("Folder references changed. Start a new search.");
      state = {
        ...state,
        truncated: state.truncated || (result.truncated && result.nextState === undefined),
        ...(result.nextState === undefined
          ? { sources: state.sources.slice(1), current: undefined }
          : { current: { ...current, scan: result.nextState } }),
      };
      const more = state.sources.length > 0;
      return {
        matches: result.matches.map((match) => ({
          ...match,
          path: `${source.prefix}${match.path}`,
        })),
        truncated: more || state.truncated,
        ...(result.regexFallbackError === undefined
          ? {}
          : { regexFallbackError: result.regexFallbackError }),
        ...(more ? { nextCursor: yield* cursors.save(state) } : {}),
      };
    }).pipe(
      Effect.tapError((error) =>
        typeof error === "string"
          ? Effect.void
          : Effect.logError("drive content search failed", { cause: error }),
      ),
      Effect.mapError((error) =>
        typeof error === "string"
          ? error
          : isReadError(error)
            ? error.message
            : "The folder could not be searched. Try again.",
      ),
    );
});
