import type { ProjectSearchContentsInput, ProjectSearchContentsResult } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DriveDirectory from "../drive/DriveDirectory.ts";
import * as DriveFiles from "../drive/DriveFiles.ts";
import { parseDriveId } from "../drive/driveAccess.ts";
import * as SearchErrors from "./DriveContentSearchErrors.ts";
import { MAIN_REF, threadRef, wipRef } from "../drive/DriveStore.ts";
import * as GitHub from "../github/GitHub.ts";
import * as GitHubConnection from "../github/GitHubConnection.ts";
import * as CloudThreadService from "../thread/CloudThreadService.ts";
import type { Actor } from "../thread/ThreadEngine.ts";
import { driveOfProject, driveOfRoot, threadWorktreeAt } from "./contextProjects.ts";
import { type ContentSearchCursor, type ContentSearchSource } from "./ContentSearchCursors.ts";
import * as ContentSearchCursors from "./ContentSearchCursors.ts";
import * as UserDrives from "./UserDrives.ts";
import * as UserFolders from "./UserFolders.ts";

export class DriveContentSearch extends Context.Service<
  DriveContentSearch,
  {
    readonly query: (
      actor: Actor,
      input: ProjectSearchContentsInput,
    ) => Effect.Effect<ProjectSearchContentsResult, SearchErrors.Failure>;
  }
>()("@signalbox/cloud/user/DriveContentSearch") {}
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
const atStage = <A, E, R>(
  stage: SearchErrors.ContentSearchFailed["stage"],
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.mapError((cause) =>
      SearchErrors.isFailure(cause)
        ? cause
        : new SearchErrors.ContentSearchFailed({ stage, cause }),
    ),
  );

const make = Effect.gen(function* () {
  const files = yield* Effect.serviceOption(DriveFiles.DriveFiles);
  const directory = yield* Effect.serviceOption(DriveDirectory.DriveDirectory);
  const drives = yield* UserDrives.UserDrives;
  const folders = yield* UserFolders.UserFolders;
  const threads = yield* CloudThreadService.CloudThreadService;
  const github = yield* Effect.serviceOption(GitHub.GitHub);
  const connection = yield* Effect.serviceOption(GitHubConnection.GitHubConnection);
  const cursors = yield* ContentSearchCursors.ContentSearchCursors;

  const allowed = (actor: Actor, driveId: string) =>
    atStage(
      "source_access",
      Effect.gen(function* () {
        const contextId = parseDriveId(driveId)?.contextId;
        if (contextId === undefined || !actor.contextIds.includes(contextId)) return false;
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
      }),
    );

  const sourceAllowed = (actor: Actor, source: ContentSearchSource) =>
    atStage(
      "source_references",
      Effect.gen(function* () {
        if (!(yield* allowed(actor, source.driveId)) || Option.isNone(directory)) return false;
        for (const edge of source.route) {
          if (!(yield* allowed(actor, edge.from))) return false;
          const links = yield* directory.value.forDrive(edge.from).shortcuts();
          if (!links.some((link) => link.path === edge.path && link.target === edge.target))
            return false;
        }
        return true;
      }),
    );

  const query: DriveContentSearch["Service"]["query"] = Effect.fn("DriveContentSearch.query")(
    function* (actor, input) {
      const userId = yield* atStage("identity", drives.userId);
      if (userId === null || actor.userId !== userId)
        return yield* new SearchErrors.ContentSearchDenied({});
      if (Option.isNone(files) || Option.isNone(directory))
        return yield* new SearchErrors.ContentSearchUnavailable({});
      const worktree = threadWorktreeAt(input.cwd);
      const root = worktree?.driveId ?? driveOfRoot(input.cwd, userId);
      if (root === null || !(yield* allowed(actor, root)))
        return yield* new SearchErrors.ContentSearchDenied({});
      if (worktree !== null) {
        const snapshot = yield* threads
          .threadSnapshot(actor, worktree.threadId)
          .pipe(Effect.mapError((cause) => new SearchErrors.ContentSearchDenied({ cause })));
        if (driveOfProject(snapshot.projection.thread.projectId, userId) !== root)
          return yield* new SearchErrors.ContentSearchDenied({});
      }
      const fingerprint = fingerprintOf([
        input.cwd,
        input.query,
        input.limit,
        input.caseSensitive,
        input.wholeWord,
        input.useRegex,
      ]);
      const saved =
        input.cursor === undefined
          ? null
          : yield* atStage("cursor_read", cursors.read(input.cursor));
      if (
        input.cursor !== undefined &&
        (saved === null || saved.fingerprint !== fingerprint || saved.root !== root)
      )
        return yield* new SearchErrors.ContentSearchExpired({});
      let state: ContentSearchCursor = saved ?? {
        fingerprint,
        root,
        sources: [{ driveId: root, prefix: "", route: [] }],
        seen: [root],
        truncated: false,
      };
      const source = state.sources[0];
      if (source === undefined) return { matches: [], truncated: state.truncated };
      if (!(yield* sourceAllowed(actor, source))) {
        state = { ...state, sources: state.sources.slice(1), current: undefined };
        return {
          matches: [],
          truncated: state.sources.length > 0 || state.truncated,
          ...(state.sources.length > 0
            ? { nextCursor: yield* atStage("cursor_save", cursors.save(state)) }
            : {}),
        };
      }
      if (state.current === undefined) {
        const shortcuts = yield* atStage(
          "source_references",
          directory.value.forDrive(source.driveId).shortcuts(),
        );
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
            commit: yield* atStage(
              "snapshot",
              files.value.contentSearchSnapshot(source.driveId, at),
            ),
            excluded: shortcuts.map((link) => link.path),
            links: shortcuts.map(({ path, target }) => ({ path, target })),
          },
        };
        if (input.cursor !== undefined && saved !== null) {
          const bound = yield* atStage("cursor_bind", cursors.bind(input.cursor, saved, state));
          if (bound === null) return yield* new SearchErrors.ContentSearchExpired({});
          state = bound;
        }
      }
      const current = state.current!;
      const result = yield* atStage(
        "scan",
        files.value.searchContents(
          source.driveId,
          input,
          current.commit,
          current.scan,
          current.excluded,
        ),
      );
      // Membership or the reference route may have changed while R2/GitHub was being read.
      if (!(yield* allowed(actor, root)) || !(yield* sourceAllowed(actor, source)))
        return yield* new SearchErrors.ContentSearchDenied({});
      const nowShortcuts = yield* atStage(
        "source_references",
        directory.value.forDrive(source.driveId).shortcuts(),
      );
      if (
        nowShortcuts.length !== current.links.length ||
        nowShortcuts.some(
          (link) =>
            !current.links.some(
              (previous) => previous.path === link.path && previous.target === link.target,
            ),
        )
      )
        return yield* new SearchErrors.ContentSearchReferencesChanged({});
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
        ...(more ? { nextCursor: yield* atStage("cursor_save", cursors.save(state)) } : {}),
      };
    },
  );
  return DriveContentSearch.of({ query });
});

export const layer = Layer.effect(DriveContentSearch, make).pipe(
  Layer.provide(ContentSearchCursors.layerSql),
);
