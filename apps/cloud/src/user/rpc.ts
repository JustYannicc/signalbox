import {
  type AuthEnvironmentScope,
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
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
  SectionsRpcError,
  type ThreadId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import {
  SIGNALBOX_CONTEXTS_REQUIRED_SCOPES,
  SIGNALBOX_CONTEXTS_WS_METHODS,
} from "@t3tools/contracts/signalboxContexts";
import {
  SIGNALBOX_DRIVES_REQUIRED_SCOPES,
  SIGNALBOX_DRIVES_WS_METHODS,
  SignalboxDrivesUnavailableError,
} from "@t3tools/contracts/signalboxDrives";
import {
  SIGNALBOX_PREVIEWS_REQUIRED_SCOPES,
  SIGNALBOX_PREVIEWS_WS_METHODS,
  SignalboxPreviewError,
  SignalboxPreviewsUnavailableError,
} from "@t3tools/contracts/signalboxPreviews";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type * as RpcGroup from "effect/rpc/RpcGroup";

import * as Environment from "../environment.ts";
import * as DriveBrowsing from "./driveBrowsing.ts";
import * as CloudThreadService from "../thread/CloudThreadService.ts";
import { type Actor, ThreadNotFoundError } from "../thread/ThreadEngine.ts";
import { DriveSharing } from "./DriveSharing.ts";
import * as UserContexts from "./UserContexts.ts";
import * as UserDrives from "./UserDrives.ts";
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
  ...Object.values(SIGNALBOX_CONTEXTS_WS_METHODS),
  ...Object.values(SIGNALBOX_DRIVES_WS_METHODS),
  ...Object.values(SIGNALBOX_PREVIEWS_WS_METHODS),
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
  ...SIGNALBOX_CONTEXTS_REQUIRED_SCOPES,
  ...SIGNALBOX_DRIVES_REQUIRED_SCOPES,
  ...SIGNALBOX_PREVIEWS_REQUIRED_SCOPES,
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
 * Handlers for one connection, acting for `userId`. Every thread RPC is one
 * `CloudThreadService` call with its errors mapped to the contract's; the
 * sidebar comes from the user's own `UserShell`, contexts from their
 * `UserContexts`, drives from their `UserDrives` and sections from their
 * `UserSections`, so every connection sees every other connection's changes.
 * Each call acts within the user's contexts as they are at that moment, and
 * an open thread stream ends as soon as the user can't see the thread anymore.
 * Storage failures are bugs, not answers a client can act on.
 */
export const layerHandlers = (input: {
  readonly identity: Environment.CloudEnvironmentIdentity;
  readonly userId: string;
}) =>
  CloudRpcGroup.toLayer(
    Effect.gen(function* () {
      const shell = yield* UserShell.UserShell;
      const threads = yield* CloudThreadService.CloudThreadService;
      const contexts = yield* UserContexts.UserContexts;
      const sections = yield* UserSections.UserSections;
      const userDrives = yield* UserDrives.UserDrives;
      const sharing = yield* Effect.serviceOption(DriveSharing);
      const { userId, identity } = input;
      const actorNow: Effect.Effect<Actor> = Effect.map(
        Effect.orDie(userDrives.contextIds),
        (contextIds) => ({ userId, contextIds }),
      );
      const drives = yield* DriveBrowsing.makeDriveBrowsing(userId, actorNow);
      /**
       * Fails with not-found once the user leaves a context and so can't see
       * the thread anymore. Only a context going away is worth asking the
       * thread about; drive changes leave a thread's visibility alone.
       */
      const lostSight = (threadId: ThreadId) =>
        Effect.gen(function* () {
          let known = new Set((yield* actorNow).contextIds);
          return yield* userDrives.changed.pipe(
            Stream.mapEffect(() =>
              Effect.gen(function* () {
                const actor = yield* actorNow;
                const left = [...known].some((id) => !actor.contextIds.includes(id));
                known = new Set(actor.contextIds);
                if (!left) return false;
                return yield* threads.threadSnapshot(actor, threadId).pipe(
                  Effect.as(false),
                  Effect.catchTags({ ThreadNotFoundError: () => Effect.succeed(true) }),
                  Effect.orElseSucceed(() => false),
                );
              }),
            ),
            Stream.filter((lost) => lost),
            Stream.runHead,
          );
        }).pipe(Effect.andThen(Effect.fail(new ThreadNotFoundError())));
      const sharingCall = <A, E>(
        call: (service: DriveSharing["Service"]) => Effect.Effect<A, E>,
      ) =>
        sharing._tag === "None"
          ? Effect.fail(new SignalboxDrivesUnavailableError())
          : call(sharing.value);
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
            Effect.flatMap(actorNow, (actor) => threads.dispatchCommand(actor, command)),
            (message) =>
              new OrchestrationV2DispatchCommandError({
                commandId: command.commandId,
                commandType: command.type,
                message,
              }),
          ),
        [ORCHESTRATION_V2_WS_METHODS.launchThread]: (request) =>
          threadCall(
            Effect.flatMap(actorNow, (actor) => threads.launchThread(actor, request)),
            (message) =>
              new OrchestrationV2ThreadLaunchError({
                commandId: request.commandId,
                projectId: request.projectId,
                message,
              }),
          ),
        [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (request) =>
          Stream.unwrap(
            Effect.map(actorNow, (actor) => threads.subscribeThread(actor, request)),
          ).pipe(
            Stream.interruptWhen(lostSight(request.threadId)),
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
              Effect.flatMap(actorNow, (actor) => threads.threadSnapshot(actor, request.threadId)),
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
        [SIGNALBOX_CONTEXTS_WS_METHODS.subscribe]: () => Stream.orDie(contexts.changes),
        [SIGNALBOX_DRIVES_WS_METHODS.subscribe]: () => Stream.orDie(userDrives.changes),
        [SIGNALBOX_DRIVES_WS_METHODS.create]: (request) =>
          sharingCall((service) => service.create(request)),
        [SIGNALBOX_DRIVES_WS_METHODS.members]: (request) =>
          sharingCall((service) =>
            Effect.map(service.members(request.driveId), (members) => ({ members })),
          ),
        [SIGNALBOX_DRIVES_WS_METHODS.share]: (request) =>
          sharingCall((service) => service.share(request)),
        [SIGNALBOX_DRIVES_WS_METHODS.unshare]: (request) =>
          sharingCall((service) => service.unshare(request)),
        [SIGNALBOX_DRIVES_WS_METHODS.shareFolder]: (request) =>
          sharingCall((service) => service.shareFolder(request)),
        [SIGNALBOX_PREVIEWS_WS_METHODS.subscribe]: ({ threadId }) =>
          identity.previews !== true
            ? Stream.fail(new SignalboxPreviewsUnavailableError())
            : Stream.unwrap(
                Effect.map(actorNow, (actor) => threads.previews(actor, threadId)),
              ).pipe(
                Stream.map((ports) => ({ threadId, ports })),
                Stream.tapError(logUnavailable),
                Stream.mapError(
                  (error) => new SignalboxPreviewError({ message: failureMessage(error) }),
                ),
              ),
        [SIGNALBOX_PREVIEWS_WS_METHODS.open]: ({ threadId, port }) =>
          identity.previews !== true
            ? Effect.fail(new SignalboxPreviewsUnavailableError())
            : threadCall(
                Effect.flatMap(actorNow, (actor) => threads.openPreview(actor, threadId, port)),
                (message) => new SignalboxPreviewError({ message }),
              ).pipe(
                Effect.flatMap((link) =>
                  link._tag === "ok"
                    ? Effect.succeed({ url: link.url })
                    : Effect.fail(new SignalboxPreviewError({ message: link.message })),
                ),
              ),
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
