import {
  type AuthEnvironmentScope,
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  EnvironmentAuthorizationError,
  GitCommandError,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetTurnDiffError,
  OrchestrationV2DispatchCommandError,
  OrchestrationV2GetShellSnapshotError,
  OrchestrationV2GetThreadProjectionError,
  OrchestrationV2ThreadLaunchError,
  ProjectListEntriesError,
  ProjectReadFileError,
  ProjectSearchEntriesError,
  RpcScopeAuthorization,
  type ProjectCloneListEvent,
  SectionsRpcError,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import {
  SIGNALBOX_CONTEXTS_REQUIRED_SCOPES,
  SIGNALBOX_CONTEXTS_WS_METHODS,
} from "@t3tools/contracts/signalboxContexts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type * as RpcGroup from "effect/rpc/RpcGroup";

import * as Environment from "../environment.ts";
import * as GitHubBranches from "../github/GitHubBranches.ts";
import { makeGitHubImport } from "../github/GitHubImport.ts";
import * as DriveBrowsing from "./driveBrowsing.ts";
import * as CloudThreadService from "../thread/CloudThreadService.ts";
import type { Actor } from "../thread/ThreadEngine.ts";
import * as UserContexts from "./UserContexts.ts";
import * as UserSections from "./UserSections.ts";
import * as UserShell from "./UserShell.ts";

/**
 * The slice of the environment RPC protocol a user's object serves: enough
 * for a client to connect, render the user's sidebar with its contexts and
 * sections (see `UserContexts` and `UserSections`), and work in threads. The
 * group is `WsRpcGroup` itself with everything else omitted, so every payload
 * and stream item is the contract's own schema. A client calling anything
 * else gets a per-request "unknown request tag" failure rather than a dropped
 * connection.
 */

/** `WS_METHODS`' sections RPCs (`sectionsRpc.ts`), all served from the user's `UserSections`. */
const SECTION_METHODS = [
  WS_METHODS.sectionsSubscribe,
  WS_METHODS.sectionsCreate,
  WS_METHODS.sectionsUpdate,
  WS_METHODS.sectionsMove,
  WS_METHODS.sectionsDelete,
  WS_METHODS.sectionsMoveProject,
] as const;

const SERVED = [
  WS_METHODS.subscribeServerConfig,
  WS_METHODS.serverGetConfig,
  WS_METHODS.serverProbe,
  WS_METHODS.serverReportClientActivity,
  WS_METHODS.subscribeServerLifecycle,
  ORCHESTRATION_V2_WS_METHODS.subscribeShell,
  ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
  ORCHESTRATION_V2_WS_METHODS.launchThread,
  ORCHESTRATION_V2_WS_METHODS.subscribeThread,
  ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
  WS_METHODS.projectsEnsureScratch,
  // Drives, browsed without a machine (`driveBrowsing.ts`).
  WS_METHODS.projectsListEntries,
  WS_METHODS.projectsReadFile,
  WS_METHODS.projectsSearchEntries,
  WS_METHODS.reviewGetDiffPreview,
  ORCHESTRATION_V2_WS_METHODS.getTurnDiff,
  ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff,
  // GitHub repositories as drives (`github/`): import, branch status, push and pull requests.
  WS_METHODS.serverDiscoverSourceControl,
  WS_METHODS.sourceControlLookupRepository,
  WS_METHODS.projectCloneStart,
  WS_METHODS.projectCloneCancel,
  WS_METHODS.projectCloneRetry,
  WS_METHODS.subscribeProjectClones,
  WS_METHODS.subscribeVcsStatus,
  WS_METHODS.vcsRefreshStatus,
  WS_METHODS.vcsPull,
  WS_METHODS.gitRunStackedAction,
  ...Object.values(SIGNALBOX_CONTEXTS_WS_METHODS),
  ...SECTION_METHODS,
] as const;
type ServedTag = (typeof SERVED)[number];
type WsRpcs = RpcGroup.Rpcs<typeof WsRpcGroup>;
type CloudRpcs = Extract<WsRpcs, { readonly _tag: ServedTag }>;

const servedTags: ReadonlySet<string> = new Set(SERVED);

// `omit` takes the unserved tags, which only exist at runtime; the result is
// exactly the served RPCs.
export const CloudRpcGroup = WsRpcGroup.omit(
  ...([...WsRpcGroup.requests.keys()].filter((tag) => !servedTags.has(tag)) as Array<
    WsRpcs["_tag"]
  >),
) as unknown as RpcGroup.RpcGroup<CloudRpcs>;

/** Same scopes the self-hosted server requires for these RPCs. */
const REQUIRED_SCOPES = {
  [WS_METHODS.subscribeServerConfig]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetConfig]: AuthOrchestrationReadScope,
  [WS_METHODS.serverProbe]: AuthOrchestrationReadScope,
  [WS_METHODS.serverReportClientActivity]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeServerLifecycle]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.launchThread]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsEnsureScratch]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsListEntries]: AuthFilesystemReadScope,
  [WS_METHODS.projectsReadFile]: AuthFilesystemReadScope,
  [WS_METHODS.projectsSearchEntries]: AuthFilesystemReadScope,
  [WS_METHODS.reviewGetDiffPreview]: AuthFilesystemReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getTurnDiff]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff]: AuthOrchestrationReadScope,
  [WS_METHODS.serverDiscoverSourceControl]: AuthOrchestrationReadScope,
  [WS_METHODS.sourceControlLookupRepository]: AuthOrchestrationReadScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.subscribeProjectClones]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeVcsStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.vcsRefreshStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  ...SIGNALBOX_CONTEXTS_REQUIRED_SCOPES,
  // The same scopes a self-hosted server requires (`apps/server/src/sections/rpcScopes.ts`).
  [WS_METHODS.sectionsSubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.sectionsCreate]: AuthOrchestrationOperateScope,
  [WS_METHODS.sectionsUpdate]: AuthOrchestrationOperateScope,
  [WS_METHODS.sectionsMove]: AuthOrchestrationOperateScope,
  [WS_METHODS.sectionsDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.sectionsMoveProject]: AuthOrchestrationOperateScope,
} as const satisfies Record<ServedTag, AuthEnvironmentScope>;

/** Authorizes every RPC on one connection against that connection's session scopes. */
export const layerScopeAuthorization = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  Layer.succeed(RpcScopeAuthorization)((effect, { rpc }) => {
    const requiredScope = REQUIRED_SCOPES[rpc._tag as ServedTag];
    return scopes.includes(requiredScope)
      ? effect
      : Effect.fail(
          new EnvironmentAuthorizationError({
            message: `The authenticated token is missing required scope: ${requiredScope}.`,
            requiredScope,
          }),
        );
  });

/** Live streams that have nothing more to say stay open: ending one tells the client to reconnect. */
const thenHold = <A>(items: ReadonlyArray<A>) =>
  Stream.concat(Stream.fromIterable(items), Stream.never);

/** The message a client shows when a thread call fails. */
const failureMessage = (error: CloudThreadService.CloudThreadError) => {
  switch (error._tag) {
    case "ThreadNotFoundError":
      return "Thread not found.";
    case "ThreadCommandRejectedError":
      return error.reason;
    case "ThreadObjectError":
      return "The thread is unavailable right now. Try again.";
  }
};

const logUnavailable = (error: CloudThreadService.CloudThreadError) =>
  error._tag === "ThreadObjectError"
    ? Effect.logError("cloud thread call failed", { cause: error })
    : Effect.void;

/** A thread call as an RPC answers it: unavailable objects logged, errors in the contract's shape. */
const threadCall = <A, E>(
  effect: Effect.Effect<A, CloudThreadService.CloudThreadError>,
  toError: (message: string) => E,
) =>
  effect.pipe(
    Effect.tapError(logUnavailable),
    Effect.mapError((error) => toError(failureMessage(error))),
  );

/** The contract's storage failure; the cause stays in the object's logs. */
const sectionsStorageFailure = () =>
  new SectionsRpcError({ code: "storage-failed", detail: "Could not load or update sections." });

const storageFailed = (cause: unknown) =>
  Effect.logError("cloud sections storage failed", { cause }).pipe(
    Effect.andThen(Effect.fail(sectionsStorageFailure())),
  );

/**
 * Handlers for one connection, acting for `actor`. Every thread RPC is one
 * `CloudThreadService` call with its errors mapped to the contract's; the
 * sidebar comes from the user's own `UserShell`, and contexts from their
 * `UserContexts` and sections from their `UserSections`, so every connection
 * sees every other connection's changes.
 * Storage failures are bugs, not answers a client can act on.
 */
export const layerHandlers = (input: {
  readonly identity: Environment.CloudEnvironmentIdentity;
  readonly actor: Actor;
}) =>
  CloudRpcGroup.toLayer(
    Effect.gen(function* () {
      const shell = yield* UserShell.UserShell;
      const threads = yield* CloudThreadService.CloudThreadService;
      const contexts = yield* UserContexts.UserContexts;
      const sections = yield* UserSections.UserSections;
      const { actor, identity } = input;
      const drives = yield* DriveBrowsing.makeDriveBrowsing(actor);
      const githubImport = yield* makeGitHubImport(actor);
      const branches = yield* GitHubBranches.GitHubBranches;
      const config = Effect.map(Clock.currentTimeMillis, (now) =>
        Environment.serverConfig(identity, DateTime.formatIso(DateTime.makeUnsafe(now))),
      );
      return {
        [WS_METHODS.subscribeServerConfig]: () =>
          Stream.unwrap(
            Effect.map(config, (current) =>
              thenHold([{ version: 1, type: "snapshot", config: current } as const]),
            ),
          ),
        [WS_METHODS.serverGetConfig]: () => config,
        [WS_METHODS.serverProbe]: () => Effect.succeed({}),
        [WS_METHODS.serverReportClientActivity]: () => Effect.void,
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.unwrap(
            Effect.gen(function* () {
              const at = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
              return thenHold([
                {
                  version: 1,
                  sequence: 0,
                  type: "welcome",
                  payload: Environment.welcome(identity),
                } as const,
                {
                  version: 1,
                  sequence: 1,
                  type: "ready",
                  payload: { at, environment: Environment.descriptor(identity) },
                } as const,
              ]);
            }),
          ),
        [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: (request) =>
          Stream.unwrap(
            shell.subscribe(request).pipe(
              Effect.map((stream) => Stream.concat(stream, Stream.never)),
              Effect.mapError(
                (cause) =>
                  new OrchestrationV2GetShellSnapshotError({
                    message: "The sidebar is unavailable right now.",
                    cause,
                  }),
              ),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command) =>
          threadCall(
            threads.dispatchCommand(actor, command),
            (message) =>
              new OrchestrationV2DispatchCommandError({
                commandId: command.commandId,
                commandType: command.type,
                message,
              }),
          ),
        [ORCHESTRATION_V2_WS_METHODS.launchThread]: (request) =>
          threadCall(
            threads.launchThread(actor, request),
            (message) =>
              new OrchestrationV2ThreadLaunchError({
                commandId: request.commandId,
                projectId: request.projectId,
                message,
              }),
          ),
        [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (request) =>
          threads.subscribeThread(actor, request).pipe(
            Stream.flattenIterable,
            Stream.tapError(logUnavailable),
            Stream.mapError(
              (error) =>
                new OrchestrationV2GetThreadProjectionError({
                  threadId: request.threadId,
                  message: failureMessage(error),
                }),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: (request) =>
          threadCall(
            Effect.map(
              threads.threadSnapshot(actor, request.threadId),
              (snapshot) => snapshot.projection,
            ),
            (message) =>
              new OrchestrationV2GetThreadProjectionError({ threadId: request.threadId, message }),
          ),
        // Scratch is the Personal context's project, always in the shell.
        [WS_METHODS.projectsEnsureScratch]: () =>
          Effect.succeed({ projectId: Environment.SCRATCH_PROJECT_ID }),
        [WS_METHODS.projectsListEntries]: (request) =>
          drives.listEntries(request).pipe(
            Effect.mapError(
              (detail) =>
                new ProjectListEntriesError({
                  cwd: request.cwd,
                  failure: "directory_list_failed",
                  detail,
                }),
            ),
          ),
        [WS_METHODS.projectsReadFile]: (request) =>
          drives.readFile(request).pipe(
            Effect.mapError(
              ({ failure }) =>
                new ProjectReadFileError({
                  cwd: request.cwd,
                  relativePath: request.relativePath,
                  failure,
                }),
            ),
          ),
        [WS_METHODS.projectsSearchEntries]: (request) =>
          drives.searchEntries(request).pipe(
            Effect.mapError(
              (detail) =>
                new ProjectSearchEntriesError({
                  cwd: request.cwd,
                  queryLength: request.query.length,
                  limit: request.limit,
                  failure: "search_index_search_failed",
                  detail,
                }),
            ),
          ),
        [WS_METHODS.reviewGetDiffPreview]: (request) => drives.reviewPreview(request),
        [ORCHESTRATION_V2_WS_METHODS.getTurnDiff]: (request) =>
          drives
            .turnDiff(request)
            .pipe(Effect.mapError((message) => new OrchestrationGetTurnDiffError({ message }))),
        [ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff]: (request) =>
          drives
            .turnDiff({ ...request, fromTurnCount: 0 })
            .pipe(
              Effect.mapError((message) => new OrchestrationGetFullThreadDiffError({ message })),
            ),
        [WS_METHODS.serverDiscoverSourceControl]: () => githubImport.discover,
        [WS_METHODS.sourceControlLookupRepository]: (request) =>
          githubImport.lookup(request.repository),
        [WS_METHODS.projectCloneStart]: (request) => githubImport.importRepository(request),
        // Imports register at once and clone nothing, so there is never a clone to track.
        [WS_METHODS.projectCloneCancel]: () => Effect.succeed({ applied: false }),
        [WS_METHODS.projectCloneRetry]: () => Effect.succeed({ applied: false }),
        [WS_METHODS.subscribeProjectClones]: () => thenHold<ProjectCloneListEvent>([[]]),
        [WS_METHODS.subscribeVcsStatus]: (request) =>
          branches.watch(actor, request.cwd, request.includeRemote !== false),
        [WS_METHODS.vcsRefreshStatus]: (request) =>
          Effect.map(branches.status(actor, request.cwd, true), (status) => ({
            ...status.local,
            ...(status.remote ?? { hasUpstream: false, aheadCount: 0, behindCount: 0, pr: null }),
          })),
        [WS_METHODS.gitRunStackedAction]: (request) => branches.runAction(actor, request),
        // A thread's branch only takes commits from its own turns.
        [WS_METHODS.vcsPull]: (request) =>
          Effect.fail(
            new GitCommandError({
              operation: "pull",
              command: "git pull",
              cwd: request.cwd,
              detail:
                "The branch on GitHub has commits this thread doesn't. Signalbox can't bring them into a thread yet.",
            }),
          ),
        [SIGNALBOX_CONTEXTS_WS_METHODS.subscribe]: () => Stream.orDie(contexts.changes),
        [WS_METHODS.sectionsSubscribe]: () =>
          sections.changes.pipe(
            Stream.tapError((cause) => Effect.logError("cloud sections stream failed", { cause })),
            Stream.mapError(sectionsStorageFailure),
          ),
        [WS_METHODS.sectionsCreate]: (request) =>
          sections.create(request).pipe(Effect.catchTags({ SqlError: storageFailed })),
        [WS_METHODS.sectionsUpdate]: (request) =>
          sections.update(request).pipe(Effect.catchTags({ SqlError: storageFailed })),
        [WS_METHODS.sectionsMove]: (request) =>
          sections.move(request).pipe(Effect.catchTags({ SqlError: storageFailed })),
        [WS_METHODS.sectionsDelete]: (request) =>
          sections.delete(request).pipe(Effect.catchTags({ SqlError: storageFailed })),
        [WS_METHODS.sectionsMoveProject]: (request) =>
          sections.moveProject(request).pipe(Effect.catchTags({ SqlError: storageFailed })),
      };
    }),
  );
