import {
  type ProjectId,
  type AuthEnvironmentScope,
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  AuthPreviewOperateScope,
  AuthSourceControlWriteScope,
  AuthStandardClientScopes,
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
  ThreadId,
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
  SIGNALBOX_FOLDERS_REQUIRED_SCOPES,
  SIGNALBOX_FOLDERS_WS_METHODS,
  SignalboxFolderError,
} from "@t3tools/contracts/signalboxFolders";
import { SIGNALBOX_NOTES_REQUIRED_SCOPES } from "@t3tools/contracts/signalboxNotes";
import {
  SIGNALBOX_BROWSING_REQUIRED_SCOPES,
  SIGNALBOX_BROWSING_WS_METHODS,
} from "@t3tools/contracts/signalboxBrowsing";
import {
  SIGNALBOX_AGENT_BROWSER_WS_METHODS,
  SIGNALBOX_PREVIEWS_REQUIRED_SCOPES,
  SIGNALBOX_PREVIEWS_WS_METHODS,
  SignalboxPreviewError,
  SignalboxPreviewsUnavailableError,
} from "@t3tools/contracts/signalboxPreviews";
import {
  SIGNALBOX_PUSH_REQUIRED_SCOPES,
  SIGNALBOX_PUSH_WS_METHODS,
} from "@t3tools/contracts/signalboxPush";
import {
  SIGNALBOX_KEYS_REQUIRED_SCOPES,
  SIGNALBOX_KEYS_WS_METHODS,
} from "@t3tools/contracts/signalboxKeys";
import {
  SIGNALBOX_SIGN_IN_REQUIRED_SCOPES,
  SIGNALBOX_SIGN_IN_WS_METHODS,
} from "@t3tools/contracts/signalboxSignIn";
import {
  SIGNALBOX_PERSON_BROWSER_REQUIRED_SCOPES,
  SIGNALBOX_PERSON_BROWSER_WS_METHODS,
  SignalboxPersonBrowserError,
} from "@t3tools/contracts/signalboxPersonBrowser";
import {
  SIGNALBOX_REPOSITORIES_REQUIRED_SCOPES,
  SIGNALBOX_REPOSITORIES_WS_METHODS,
} from "@t3tools/contracts/signalboxRepositories";
import {
  SIGNALBOX_THREAD_KINDS_REQUIRED_SCOPES,
  SIGNALBOX_THREAD_KINDS_WS_METHODS,
  SignalboxThreadKindsError,
} from "@t3tools/contracts/signalboxThreadKinds";
import {
  SIGNALBOX_THREAD_STATUS_REQUIRED_SCOPES,
  SIGNALBOX_THREAD_STATUS_WS_METHODS,
  SignalboxThreadStatusUnavailableError,
} from "@t3tools/contracts/signalboxStatusLine";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import type { SqlError } from "effect/sql/SqlError";

import * as CloudAssets from "../assets/CloudAssets.ts";
import { CloudAttachments } from "../attachments/CloudAttachments.ts";
import * as Environment from "../environment.ts";
import * as GitHubActions from "../github/GitHubActions.ts";
import * as GitHubBranches from "../github/GitHubBranches.ts";
import * as CloudPullRequests from "../github/CloudPullRequestsService.ts";
import { makeGitHubImport } from "../github/GitHubImport.ts";
import * as DriveBrowsing from "./driveBrowsing.ts";
import * as CloudThreadService from "../thread/CloudThreadService.ts";
import * as Threads from "../thread/Threads.ts";
import { deviceMember, makeBrowsingHandlers } from "../thread/browsing/browsingRpc.ts";
import { type Actor, ThreadNotFoundError } from "../thread/ThreadAccess.ts";
import type { BrowserReply } from "../thread/threadWire.ts";
import { DriveSharing } from "./DriveSharing.ts";
import { makePoolHandlers, POOL_METHODS, POOL_REQUIRED_SCOPES } from "./poolRpc.ts";
import { AUTOMATION_METHODS, makeAutomationHandlers } from "../automations/automationRpc.ts";
import { ThreadContexts } from "./threadContexts.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import { AUTOMATION_RPC_SCOPES } from "@signalbox/automations/rpcScopes";
import { makePushHandlers } from "../push/pushRpc.ts";
import { makeKeysHandlers } from "./keysRpc.ts";
import { makeSignInHandlers } from "../signIn/signInRpc.ts";
import * as LoginService from "../signIn/LoginService.ts";
import {
  ANALYTICS_METHODS,
  ANALYTICS_REQUIRED_SCOPES,
  makeAnalyticsHandlers,
} from "./analyticsRpc.ts";
import { makeNotesHandlers, NOTES_METHODS } from "../notes/notesRpc.ts";
import { DriveShortcuts } from "./DriveShortcuts.ts";
import * as UserContexts from "./UserContexts.ts";
import * as UserDrives from "./UserDrives.ts";
import * as LegacySections from "./legacySections.ts";
import * as UserFolders from "./UserFolders.ts";
import * as UserShell from "./UserShell.ts";
import * as UserThreadKinds from "./UserThreadKinds.ts";
import * as UserThreadStatus from "./UserThreadStatus.ts";

/**
 * The slice of the environment RPC protocol a user's object serves: enough
 * for a client to connect, render the user's sidebar with its folders (see
 * `UserFolders`, and `legacySections.ts` for older clients), work in threads, and
 * manage their account pools (see `poolRpc.ts`). The
 * group is `WsRpcGroup` itself with everything else omitted, so every payload
 * and stream item is the contract's own schema. A client calling anything
 * else gets a per-request "unknown request tag" failure rather than a dropped
 * connection.
 */

/** The browser panel's RPCs, served from each thread's browsing record (`thread/browsing/browsingRpc.ts`). */
const BROWSING_PREVIEW_METHODS = [
  WS_METHODS.previewOpen,
  WS_METHODS.previewNavigate,
  WS_METHODS.previewResize,
  WS_METHODS.previewAdjust,
  WS_METHODS.previewRefresh,
  WS_METHODS.previewClose,
  WS_METHODS.previewList,
  WS_METHODS.previewClearProfile,
  WS_METHODS.previewReportProfiles,
  WS_METHODS.previewReportStatus,
  WS_METHODS.subscribePreviewEvents,
] as const;

/** `WS_METHODS`' sections RPCs (`sectionsRpc.ts`), served from the user's folders for older clients. */
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
  WS_METHODS.serverUpdateSettings,
  WS_METHODS.serverProbe,
  WS_METHODS.secretsAnswerRequest,
  WS_METHODS.serverReportClientActivity,
  WS_METHODS.subscribeServerLifecycle,
  ORCHESTRATION_V2_WS_METHODS.subscribeShell,
  ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot,
  ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
  ORCHESTRATION_V2_WS_METHODS.launchThread,
  ORCHESTRATION_V2_WS_METHODS.subscribeThread,
  ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
  // Images tools returned in a thread and attachments (`assets/CloudAssets.ts`).
  WS_METHODS.assetsCreateUrl,
  WS_METHODS.projectsEnsureScratch,
  // Drives, browsed without a machine (`driveBrowsing.ts`).
  WS_METHODS.projectsListEntries,
  WS_METHODS.projectsReadFile,
  WS_METHODS.projectsSearchEntries,
  WS_METHODS.reviewGetDiffPreview,
  WS_METHODS.reviewGetDiffFileContents,
  WS_METHODS.vcsListRefs,
  ORCHESTRATION_V2_WS_METHODS.getTurnDiff,
  ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff,
  // Pasted screenshots and files (`attachments/CloudAttachments.ts`).
  WS_METHODS.attachmentsCreateUploadUrl,
  WS_METHODS.attachmentsDelete,
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
  // Cloud pull-request reads (`github/CloudPullRequests.ts`).
  WS_METHODS.pullRequestsList,
  WS_METHODS.pullRequestsListStats,
  WS_METHODS.pullRequestsSummary,
  WS_METHODS.pullRequestsRouting,
  WS_METHODS.pullRequestsRoutingIdentity,
  WS_METHODS.pullRequestsStack,
  WS_METHODS.pullRequestsLinkedThreads,
  WS_METHODS.pullRequestsDetail,
  WS_METHODS.pullRequestsPreview,
  WS_METHODS.pullRequestsChecks,
  WS_METHODS.pullRequestsActivity,
  WS_METHODS.pullRequestsThreadComments,
  WS_METHODS.pullRequestsDiffFileContents,
  WS_METHODS.pullRequestsInvalidate,
  WS_METHODS.pullRequestsSubscribeRefreshes,
  WS_METHODS.gitResolvePullRequest,
  ...Object.values(SIGNALBOX_CONTEXTS_WS_METHODS),
  ...Object.values(SIGNALBOX_DRIVES_WS_METHODS),
  ...Object.values(SIGNALBOX_FOLDERS_WS_METHODS),
  // Notes on each level's pad (`notes/`).
  ...NOTES_METHODS,
  ...Object.values(SIGNALBOX_PREVIEWS_WS_METHODS),
  // A thread's synced browser tabs (`thread/browsing/`), and the browser panel's own RPCs on them.
  ...Object.values(SIGNALBOX_BROWSING_WS_METHODS),
  ...BROWSING_PREVIEW_METHODS,
  ...Object.values(SIGNALBOX_AGENT_BROWSER_WS_METHODS),
  ...Object.values(SIGNALBOX_PUSH_WS_METHODS),
  ...Object.values(SIGNALBOX_REPOSITORIES_WS_METHODS),
  ...Object.values(SIGNALBOX_THREAD_KINDS_WS_METHODS),
  // Threads' status notes (#670, `UserThreadStatus`).
  ...Object.values(SIGNALBOX_THREAD_STATUS_WS_METHODS),
  ...Object.values(SIGNALBOX_KEYS_WS_METHODS),
  ...Object.values(SIGNALBOX_SIGN_IN_WS_METHODS),
  ...Object.values(SIGNALBOX_PERSON_BROWSER_WS_METHODS),
  ...SECTION_METHODS,
  ...POOL_METHODS,
  // The user's automations (`automations/`), run on this object.
  ...AUTOMATION_METHODS,
  ...ANALYTICS_METHODS,
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
  [WS_METHODS.serverUpdateSettings]: AuthSettingsWriteScope,
  ...ANALYTICS_REQUIRED_SCOPES,
  [WS_METHODS.serverProbe]: AuthOrchestrationReadScope,
  [WS_METHODS.secretsAnswerRequest]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverReportClientActivity]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeServerLifecycle]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.launchThread]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: AuthOrchestrationReadScope,
  // A cloud serves only tool output images, which a self-hosted server gates on this scope.
  [WS_METHODS.assetsCreateUrl]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsEnsureScratch]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsListEntries]: AuthFilesystemReadScope,
  [WS_METHODS.projectsReadFile]: AuthFilesystemReadScope,
  [WS_METHODS.projectsSearchEntries]: AuthFilesystemReadScope,
  [WS_METHODS.reviewGetDiffPreview]: AuthFilesystemReadScope,
  [WS_METHODS.reviewGetDiffFileContents]: AuthFilesystemReadScope,
  [WS_METHODS.vcsListRefs]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getTurnDiff]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff]: AuthOrchestrationReadScope,
  [WS_METHODS.attachmentsCreateUploadUrl]: AuthOrchestrationOperateScope,
  [WS_METHODS.attachmentsDelete]: AuthOrchestrationOperateScope,
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
  [WS_METHODS.pullRequestsList]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsListStats]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsSummary]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsRouting]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsRoutingIdentity]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsStack]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsLinkedThreads]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsDetail]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsPreview]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsChecks]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsActivity]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsThreadComments]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsDiffFileContents]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsInvalidate]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsSubscribeRefreshes]: AuthOrchestrationReadScope,
  [WS_METHODS.gitResolvePullRequest]: AuthOrchestrationReadScope,
  ...SIGNALBOX_CONTEXTS_REQUIRED_SCOPES,
  ...SIGNALBOX_DRIVES_REQUIRED_SCOPES,
  ...SIGNALBOX_FOLDERS_REQUIRED_SCOPES,
  ...SIGNALBOX_NOTES_REQUIRED_SCOPES,
  ...SIGNALBOX_PREVIEWS_REQUIRED_SCOPES,
  ...SIGNALBOX_BROWSING_REQUIRED_SCOPES,
  // The same scopes a self-hosted server requires for its browser panel.
  [WS_METHODS.previewOpen]: AuthPreviewOperateScope,
  [WS_METHODS.previewNavigate]: AuthPreviewOperateScope,
  [WS_METHODS.previewResize]: AuthPreviewOperateScope,
  [WS_METHODS.previewAdjust]: AuthPreviewOperateScope,
  [WS_METHODS.previewRefresh]: AuthPreviewOperateScope,
  [WS_METHODS.previewClose]: AuthPreviewOperateScope,
  [WS_METHODS.previewList]: AuthOrchestrationReadScope,
  [WS_METHODS.previewClearProfile]: AuthPreviewOperateScope,
  [WS_METHODS.previewReportProfiles]: AuthPreviewOperateScope,
  [WS_METHODS.previewReportStatus]: AuthPreviewOperateScope,
  [WS_METHODS.subscribePreviewEvents]: AuthOrchestrationReadScope,
  ...SIGNALBOX_PUSH_REQUIRED_SCOPES,
  ...SIGNALBOX_REPOSITORIES_REQUIRED_SCOPES,
  ...SIGNALBOX_THREAD_KINDS_REQUIRED_SCOPES,
  ...SIGNALBOX_THREAD_STATUS_REQUIRED_SCOPES,
  ...SIGNALBOX_KEYS_REQUIRED_SCOPES,
  ...SIGNALBOX_SIGN_IN_REQUIRED_SCOPES,
  ...SIGNALBOX_PERSON_BROWSER_REQUIRED_SCOPES,
  // The same scopes a self-hosted server requires (`apps/server/src/sections/rpcScopes.ts`).
  [WS_METHODS.sectionsSubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.sectionsCreate]: AuthOrchestrationOperateScope,
  [WS_METHODS.sectionsUpdate]: AuthOrchestrationOperateScope,
  [WS_METHODS.sectionsMove]: AuthOrchestrationOperateScope,
  [WS_METHODS.sectionsDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.sectionsMoveProject]: AuthOrchestrationOperateScope,
  ...POOL_REQUIRED_SCOPES,
  ...AUTOMATION_RPC_SCOPES,
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

/** A folder change as an RPC answers it: refusals for the user, storage failures logged. */
const folderCall = <A>(
  effect: Effect.Effect<A, UserFolders.FolderRefusedError | SqlError>,
): Effect.Effect<A, SignalboxFolderError> =>
  effect.pipe(
    Effect.catchTags({
      FolderRefusedError: (error) =>
        Effect.fail(new SignalboxFolderError({ message: error.message })),
      SqlError: (cause) =>
        Effect.logError("cloud folders storage failed", { cause }).pipe(
          Effect.andThen(
            Effect.fail(new SignalboxFolderError({ message: "Could not load or change folders." })),
          ),
        ),
    }),
  );

/** A kinds change as an RPC answers it: storage failures logged, a message for the user. */
const kindsCall = <A>(effect: Effect.Effect<A, SqlError>) =>
  effect.pipe(
    Effect.catchTags({
      SqlError: (cause) =>
        Effect.logError("cloud thread kinds storage failed", { cause }).pipe(
          Effect.andThen(
            Effect.fail(
              new SignalboxThreadKindsError({
                message: "Could not load or change chat and task kinds.",
              }),
            ),
          ),
        ),
    }),
  );

const personBrowserCall = <A, E>(
  effect: Effect.Effect<A, E>,
  message: string,
): Effect.Effect<A, SignalboxPersonBrowserError> =>
  effect.pipe(
    Effect.tapError((cause) =>
      Effect.logError("cloud browser profile operation failed", { cause }),
    ),
    Effect.mapError(() => new SignalboxPersonBrowserError({ message })),
  );

const storageFailed = (cause: unknown) =>
  Effect.logError("cloud sections storage failed", { cause }).pipe(
    Effect.andThen(Effect.fail(sectionsStorageFailure())),
  );

/**
 * Handlers for one connection, acting for `userId`. Every thread RPC is one
 * `CloudThreadService` call with its errors mapped to the contract's; the
 * sidebar comes from the user's own `UserShell`, contexts from their
 * `UserContexts`, drives from their `UserDrives` and folders from their
 * `UserFolders`, so every connection sees every other connection's changes.
 * Each call acts within the user's contexts as they are at that moment, and
 * an open thread stream ends as soon as the user can't see the thread anymore.
 * Storage failures are bugs, not answers a client can act on.
 */
export const layerHandlers = (input: {
  readonly identity: Environment.CloudEnvironmentIdentity;
  readonly userId: string;
  /** The socket's session; phones it registers get pushes while it lives. */
  readonly sid: string;
  /** What the connection's credential holds; new keys get no more. Defaults to an app's. */
  readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
  /**
   * `client`: a person's app socket. `api`: the public API (keys, CLI, MCP),
   * which may be an agent holding the person's credential, so it can't vouch
   * for what it publishes. Defaults to `api`.
   */
  readonly via?: "client" | "api";
}) =>
  CloudRpcGroup.toLayer(
    Effect.gen(function* () {
      const shell = yield* UserShell.UserShell;
      const threads = yield* CloudThreadService.CloudThreadService;
      const coreThreads = yield* Threads.Threads;
      const assets = yield* CloudAssets.CloudAssets;
      const contexts = yield* UserContexts.UserContexts;
      const sections = yield* LegacySections.LegacySections;
      const folders = yield* UserFolders.UserFolders;
      const kinds = yield* UserThreadKinds.UserThreadKinds;
      const statusNotes = yield* UserThreadStatus.UserThreadStatus;
      const userDrives = yield* UserDrives.UserDrives;
      const sharing = yield* Effect.serviceOption(DriveSharing);
      const shortcuts = yield* Effect.serviceOption(DriveShortcuts);
      const { userId, identity } = input;
      const actorNow: Effect.Effect<Actor> = Effect.map(
        Effect.orDie(userDrives.contextIds),
        (contextIds) => ({ userId, contextIds }),
      );
      const drives = yield* DriveBrowsing.makeDriveBrowsing(userId, actorNow);
      const githubImport = yield* makeGitHubImport();
      const browsing = yield* makeBrowsingHandlers({
        actorNow,
        you: yield* deviceMember(userId, input.sid),
      });
      const branches = yield* GitHubBranches.GitHubBranches;
      const githubActions = yield* GitHubActions.GitHubActions;
      const pullRequests = yield* CloudPullRequests.CloudPullRequests;
      const attachments = yield* CloudAttachments;
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
                return yield* coreThreads.snapshot(actor, threadId).pipe(
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
      /** Calls a drive service, which only a cloud that stores drives has. */
      const withDrives =
        <S>(service: Option.Option<S>) =>
        <A, E>(call: (value: S) => Effect.Effect<A, E>) =>
          service._tag === "None"
            ? Effect.fail(new SignalboxDrivesUnavailableError())
            : call(service.value);
      /** A call about the agent's browser, on a cloud that runs previews; its refusals in the previews' error. */
      const browserCall = <A>(
        call: (actor: Actor) => Effect.Effect<BrowserReply<A>, CloudThreadService.CloudThreadError>,
      ): Effect.Effect<A, SignalboxPreviewError | SignalboxPreviewsUnavailableError> =>
        identity.previews !== true
          ? Effect.fail(new SignalboxPreviewsUnavailableError())
          : threadCall(
              Effect.flatMap(actorNow, call),
              (message) => new SignalboxPreviewError({ message }),
            ).pipe(
              Effect.flatMap((reply) =>
                reply._tag === "ok"
                  ? Effect.succeed(reply.value)
                  : Effect.fail(new SignalboxPreviewError({ message: reply.message })),
              ),
            );
      const sharingCall = withDrives(sharing);
      const shortcutsCall = withDrives(shortcuts);
      const pools = yield* makePoolHandlers({ identity, actor: { userId } });
      const pushes = yield* makePushHandlers(input.sid);
      const threadContexts = yield* ThreadContexts;
      const newThreadModel = (projectId?: ProjectId) =>
        threadContexts
          .initialModelSelection(projectId ?? null)
          .pipe(
            Effect.map(
              (selection) => selection ?? (identity.scripted ? scriptedModelSelection : null),
            ),
          );
      const automations = yield* makeAutomationHandlers({
        personReviews: input.via === "client",
        newThreadModel,
      });
      const notes = yield* makeNotesHandlers({ newThreadModel });
      const keys = yield* makeKeysHandlers({
        userId,
        scopes: input.scopes ?? AuthStandardClientScopes,
      });
      const signIn = yield* makeSignInHandlers({ userId });
      const personBrowser = yield* LoginService.LoginService;
      const analytics = yield* makeAnalyticsHandlers;
      return {
        ...pools.handlers,
        ...pushes,
        ...automations,
        ...notes,
        ...keys,
        ...signIn,
        [SIGNALBOX_PERSON_BROWSER_WS_METHODS.profileStatus]: () =>
          personBrowserCall(
            personBrowser.profileStatus,
            "Cloud browser availability could not be checked. Try again.",
          ),
        [SIGNALBOX_PERSON_BROWSER_WS_METHODS.clearProfile]: () =>
          personBrowserCall(
            personBrowser.clearProfile,
            "Cloud browser sign-ins could not be cleared. Try again.",
          ),
        ...analytics,
        [WS_METHODS.subscribeServerConfig]: (request) => pools.configStream(request),
        [WS_METHODS.serverGetConfig]: () => pools.configNow,
        [WS_METHODS.serverProbe]: () => Effect.succeed({}),
        [WS_METHODS.secretsAnswerRequest]: (request) =>
          Effect.flatMap(actorNow, (actor) => threads.answerSecret(actor, request)),
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
        // Settings' Archived list: the shell's archived threads.
        [ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]: () =>
          shell.snapshot.pipe(
            Effect.map((snapshot) => ({
              schemaVersion: snapshot.schemaVersion,
              snapshotSequence: snapshot.snapshotSequence,
              projects: snapshot.projects,
              threads: snapshot.archivedThreads,
            })),
            Effect.mapError(
              (cause) =>
                new OrchestrationV2GetShellSnapshotError({
                  message: "Archived threads are unavailable right now.",
                  cause,
                }),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command) =>
          threadCall(
            Effect.flatMap(actorNow, (actor) => coreThreads.dispatch(actor, command)),
            (message) =>
              new OrchestrationV2DispatchCommandError({
                commandId: command.commandId,
                commandType: command.type,
                message,
              }),
          ),
        [ORCHESTRATION_V2_WS_METHODS.launchThread]: (request) =>
          threadCall(
            Effect.flatMap(actorNow, (actor) => coreThreads.launch(actor, request)),
            (message) =>
              new OrchestrationV2ThreadLaunchError({
                commandId: request.commandId,
                projectId: request.projectId,
                message,
              }),
          ),
        [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (request) =>
          Stream.unwrap(
            Effect.map(actorNow, (actor) => coreThreads.subscribe(actor, request)),
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
              Effect.flatMap(actorNow, (actor) => coreThreads.snapshot(actor, request.threadId)),
              (snapshot) => snapshot.projection,
            ),
            (message) =>
              new OrchestrationV2GetThreadProjectionError({ threadId: request.threadId, message }),
          ),
        [WS_METHODS.assetsCreateUrl]: ({ resource }) =>
          Effect.flatMap(actorNow, (actor) => assets.createUrl(actor, resource)),
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
        [WS_METHODS.reviewGetDiffFileContents]: (request) =>
          drives.diffFileContents(request).pipe(
            Effect.mapError(
              (detail) =>
                new GitCommandError({
                  operation: "review.getDiffFileContents",
                  command: "drive read",
                  cwd: request.cwd,
                  detail,
                }),
            ),
          ),
        [WS_METHODS.vcsListRefs]: (request) =>
          Effect.flatMap(actorNow, (actor) => branches.listRefs(actor, request)),
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
        [WS_METHODS.attachmentsCreateUploadUrl]: (request) =>
          attachments.issueUpload(userId, request),
        [WS_METHODS.attachmentsDelete]: (request) =>
          attachments.deletePending(userId, request.attachmentId),
        [WS_METHODS.serverDiscoverSourceControl]: () => githubImport.discover,
        [WS_METHODS.sourceControlLookupRepository]: (request) =>
          githubImport.lookup(request.repository),
        [SIGNALBOX_REPOSITORIES_WS_METHODS.list]: (request) => githubImport.list(request.provider),
        [WS_METHODS.projectCloneStart]: (request) => githubImport.importRepository(request),
        // Imports register at once and clone nothing, so there is never a clone to track.
        [WS_METHODS.projectCloneCancel]: () => Effect.succeed({ applied: false }),
        [WS_METHODS.projectCloneRetry]: () => Effect.succeed({ applied: false }),
        [WS_METHODS.subscribeProjectClones]: () => thenHold<ProjectCloneListEvent>([[]]),
        [WS_METHODS.subscribeVcsStatus]: (request) =>
          Stream.unwrap(
            Effect.map(actorNow, (actor) =>
              branches.watch(actor, request.cwd, request.includeRemote !== false),
            ),
          ),
        [WS_METHODS.vcsRefreshStatus]: (request) =>
          actorNow.pipe(
            Effect.flatMap((actor) => branches.status(actor, request.cwd, true)),
            Effect.map((status) => ({
              ...status.local,
              ...(status.remote ?? { hasUpstream: false, aheadCount: 0, behindCount: 0, pr: null }),
            })),
          ),
        [WS_METHODS.pullRequestsList]: (request) => pullRequests.list(request),
        [WS_METHODS.pullRequestsListStats]: (request) => pullRequests.listStats(request),
        [WS_METHODS.pullRequestsSummary]: (request) => pullRequests.summary(request),
        [WS_METHODS.pullRequestsRouting]: (request) => pullRequests.routing(request),
        [WS_METHODS.pullRequestsRoutingIdentity]: (request) =>
          pullRequests.routingIdentity(request),
        [WS_METHODS.pullRequestsStack]: (request) => pullRequests.stack(request),
        [WS_METHODS.pullRequestsLinkedThreads]: (request) => pullRequests.linkedThreads(request),
        [WS_METHODS.pullRequestsDetail]: (request) => pullRequests.detail(request),
        [WS_METHODS.pullRequestsPreview]: (request) => pullRequests.preview(request),
        [WS_METHODS.pullRequestsChecks]: (request) => pullRequests.checks(request),
        [WS_METHODS.pullRequestsActivity]: (request) => pullRequests.activity(request),
        [WS_METHODS.pullRequestsThreadComments]: (request) => pullRequests.threadComments(request),
        [WS_METHODS.pullRequestsDiffFileContents]: (request) =>
          pullRequests.diffFileContents(request),
        [WS_METHODS.pullRequestsInvalidate]: (request) => pullRequests.invalidate(request),
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => pullRequests.subscribeRefreshes,
        [WS_METHODS.gitResolvePullRequest]: (request) => pullRequests.resolvePullRequest(request),
        [WS_METHODS.gitRunStackedAction]: (request) =>
          Stream.unwrap(Effect.map(actorNow, (actor) => branches.runAction(actor, request))),
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
        [SIGNALBOX_DRIVES_WS_METHODS.shortcuts]: (request) =>
          shortcutsCall((service) =>
            Effect.map(service.list(request.driveId), (found) => ({ shortcuts: found })),
          ),
        [SIGNALBOX_DRIVES_WS_METHODS.addShortcut]: (request) =>
          shortcutsCall((service) => service.add(request)),
        [SIGNALBOX_DRIVES_WS_METHODS.removeShortcut]: (request) =>
          shortcutsCall((service) => service.remove(request)),
        ...browsing,
        [SIGNALBOX_PREVIEWS_WS_METHODS.subscribe]: ({ threadId }) =>
          identity.previews !== true
            ? Stream.fail(new SignalboxPreviewsUnavailableError())
            : Stream.unwrap(
                Effect.map(actorNow, (actor) => threads.previews(actor, threadId)),
              ).pipe(
                Stream.map(({ ports, browsed }) => ({
                  threadId,
                  ports,
                  ...(browsed ? { browsed } : {}),
                })),
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
        [SIGNALBOX_AGENT_BROWSER_WS_METHODS.watch]: ({ threadId, tabId }) =>
          identity.previews !== true
            ? Stream.fail(new SignalboxPreviewsUnavailableError())
            : Stream.unwrap(
                Effect.map(actorNow, (actor) => threads.browserWatch(actor, threadId, tabId)),
              ).pipe(
                Stream.tapError((error) =>
                  error._tag === "BrowserWatchBehindError" ? Effect.void : logUnavailable(error),
                ),
                Stream.mapError(
                  (error) =>
                    new SignalboxPreviewError({
                      message:
                        error._tag === "BrowserWatchBehindError"
                          ? error.message
                          : failureMessage(error),
                    }),
                ),
              ),
        [SIGNALBOX_AGENT_BROWSER_WS_METHODS.input]: ({ threadId, viewerId, input: viewerInput }) =>
          Effect.asVoid(
            browserCall((actor) => threads.browserInput(actor, threadId, viewerId, viewerInput)),
          ),
        [SIGNALBOX_AGENT_BROWSER_WS_METHODS.trail]: ({ threadId }) =>
          Effect.map(
            browserCall((actor) => threads.browserTrail(actor, threadId)),
            (steps) => ({ steps }),
          ),
        [SIGNALBOX_AGENT_BROWSER_WS_METHODS.step]: ({ threadId, stepId }) =>
          Effect.map(
            browserCall((actor) => threads.browserStep(actor, threadId, stepId)),
            (events) => ({ events }),
          ),
        [SIGNALBOX_FOLDERS_WS_METHODS.subscribe]: () =>
          folders.changes.pipe(
            Stream.tapError((cause) => Effect.logError("cloud folders stream failed", { cause })),
            Stream.mapError(
              () => new SignalboxFolderError({ message: "Could not load your folders." }),
            ),
          ),
        [SIGNALBOX_FOLDERS_WS_METHODS.create]: (request) => folderCall(folders.create(request)),
        [SIGNALBOX_FOLDERS_WS_METHODS.update]: (request) => folderCall(folders.update(request)),
        [SIGNALBOX_FOLDERS_WS_METHODS.move]: (request) => folderCall(folders.move(request)),
        [SIGNALBOX_FOLDERS_WS_METHODS.delete]: (request) => folderCall(folders.delete(request)),
        [SIGNALBOX_FOLDERS_WS_METHODS.moveThread]: (request) =>
          folderCall(folders.moveThread(request)),
        [SIGNALBOX_FOLDERS_WS_METHODS.setInstructions]: (request) =>
          folderCall(folders.setInstructions(request)),
        [SIGNALBOX_FOLDERS_WS_METHODS.setPhase]: (request) => folderCall(folders.setPhase(request)),
        [SIGNALBOX_FOLDERS_WS_METHODS.setGitHubLend]: (request) =>
          folderCall(githubActions.setLend(request)),
        [SIGNALBOX_THREAD_KINDS_WS_METHODS.subscribe]: () =>
          kinds.changes.pipe(
            Stream.tapError((cause) =>
              Effect.logError("cloud thread kinds stream failed", { cause }),
            ),
            Stream.mapError(
              () =>
                new SignalboxThreadKindsError({ message: "Could not load chat and task kinds." }),
            ),
          ),
        // A snapshot, then one small item per changed note; held open like the sidebar.
        [SIGNALBOX_THREAD_STATUS_WS_METHODS.subscribe]: () =>
          Stream.concat(statusNotes.changes, Stream.never).pipe(
            Stream.tapError((cause) =>
              Effect.logError("cloud thread status stream failed", { cause }),
            ),
            Stream.mapError(() => new SignalboxThreadStatusUnavailableError()),
          ),
        [SIGNALBOX_THREAD_KINDS_WS_METHODS.setKind]: (request) => kindsCall(kinds.setKind(request)),
        [SIGNALBOX_THREAD_KINDS_WS_METHODS.setArchiveChatsAfterDays]: (request) =>
          kindsCall(kinds.setArchiveChatsAfterDays(request.days)),
        [SIGNALBOX_FOLDERS_WS_METHODS.setSecrets]: (request) =>
          folderCall(folders.setSecrets(request)),
        [SIGNALBOX_FOLDERS_WS_METHODS.setOnePassword]: (request) =>
          folderCall(folders.setOnePassword(request)),
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
