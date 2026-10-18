import { EnvironmentId } from "@t3tools/contracts";
import { PERSONAL_POOL_ID } from "@t3tools/contracts/accountHub";
import {
  WORKOS_TEST_ENV,
  type WorkOSCodes,
  type WorkOSMemberships,
  workosStubLayer,
} from "@signalbox/account/WorkOSTesting";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as ManagedRuntime from "effect/ManagedRuntime";

import * as CloudAccounts from "./account/CloudAccounts.ts";
import * as IdentityProvider from "./account/IdentityProvider.ts";
import { API_HEADER, encodeApiCredential, serveApiRequest } from "./api/apiObject.ts";
import { MCP_PATH, makeMcpHandler } from "./api/mcpObject.ts";
import * as CloudAssets from "./assets/CloudAssets.ts";
import * as CloudAutomations from "./automations/CloudAutomations.ts";
import type { KernelApi } from "./browser/KernelApi.ts";
import type { KernelAuth } from "./browser/KernelAuth.ts";
import * as PersonBrowsers from "./browser/PersonBrowsers.ts";
import type { AttachmentObjects } from "./attachments/attachmentObjects.ts";
import { makeMemoryObjects } from "./attachments/attachmentTesting.ts";
import * as CloudAttachments from "./attachments/CloudAttachments.ts";
import * as CloudSessions from "./auth/CloudSessions.ts";
import * as CloudTokens from "./auth/CloudTokens.ts";
import * as CloudConfig from "./CloudConfig.ts";
import { canWrite, myDriveId } from "./drive/driveAccess.ts";
import * as DriveDirectory from "./drive/DriveDirectory.ts";
import * as DriveFiles from "./drive/DriveFiles.ts";
import type { DrivePerson } from "./drive/DriveMembers.ts";
import type * as DrivePacks from "./drive/DrivePacks.ts";
import { makeMemoryDrives } from "./drive/driveTesting.ts";
import * as Platform from "./platform.ts";
import * as NoteReader from "./notes/NoteReader.ts";
import * as ModelCompletion from "./models/ModelCompletion.ts";
import * as UserNotes from "./notes/UserNotes.ts";
import * as PoolDirectory from "./pool/PoolDirectory.ts";
import * as PreviewSetup from "./previewSetup/PreviewSetup.ts";
import * as PushNotifier from "./push/PushNotifier.ts";
import * as UserPreviewSetup from "./previewSetup/UserPreviewSetup.ts";
import { makeMemoryPools } from "./pool/testing.ts";
import * as CloudThreadService from "./thread/CloudThreadService.ts";
import * as ThreadsLive from "./thread/ThreadsLive.ts";
import * as CloudAnalytics from "./thread/diagnostics/CloudAnalytics.ts";
import * as DiagnosticsStore from "./thread/diagnostics/DiagnosticsStore.ts";
import * as TurnDiagnostics from "./thread/diagnostics/TurnDiagnostics.ts";
import * as TurnReports from "./thread/diagnostics/TurnReports.ts";
import { deliverPendingEvents } from "./thread/eventOutbox.ts";
import { deliverPendingSummary } from "./thread/summaryOutbox.ts";
import * as ThreadDirectory from "./thread/ThreadDirectory.ts";
import * as ThreadBrowsing from "./thread/browsing/ThreadBrowsing.ts";
import * as PreviewState from "./thread/PreviewState.ts";
import * as ThreadEngine from "./thread/ThreadEngine.ts";
import * as ThreadSecretRequests from "./thread/ThreadSecrets.ts";
import * as StatusNoteModel from "./thread/statusLine/StatusNoteModel.ts";
import * as ThreadStatusNotes from "./thread/statusLine/ThreadStatusNotes.ts";
import * as ThreadKindTurns from "./thread/ThreadKindTurns.ts";
import * as LearnerService from "./learner/LearnerService.ts";
import * as LearnerJev from "./learner/LearnerJev.ts";
import * as LearnerSummary from "./learner/LearnerSummary.ts";
import * as LearnerHomes from "./user/LearnerHomes.ts";
import * as UserLearner from "./user/UserLearner.ts";
import * as KindClassifier from "./threadKinds/KindClassifier.ts";
import { makeThreadObjectApi } from "./thread/threadObjectApi.ts";
import { browserUpdateLine, previewsLine } from "./thread/threadWire.ts";
import * as MachineBackends from "./thread/runner/machineBackends.ts";
import type * as MachineBackend from "./thread/runner/MachineBackend.ts";
import * as ThreadRunner from "./thread/runner/ThreadRunner.ts";
import * as SessionRows from "./thread/session/SessionRows.ts";
import * as PullRequestPolls from "./thread/pullRequests/PullRequestPolls.ts";
import * as PullRequestSync from "./thread/pullRequests/PullRequestSync.ts";
import * as ThreadStore from "./thread/ThreadStore.ts";
import * as ThreadPulls from "./thread/ThreadPulls.ts";
import * as PullState from "./thread/PullState.ts";
import * as ModelManifest from "./models/ModelManifest.ts";
import * as ModelCatalog from "./models/ModelCatalog.ts";
import * as TurnModels from "./thread/TurnModels.ts";
import { contextOfProject } from "./user/contextProjects.ts";
import * as DrivePeople from "./user/DrivePeople.ts";
import * as DriveSharing from "./user/DriveSharing.ts";
import * as DriveShortcuts from "./user/DriveShortcuts.ts";
import * as OnePasswordAccount from "./user/OnePasswordAccount.ts";
import * as ResourceBindings from "./user/ResourceBindings.ts";
import * as ThreadContexts from "./user/threadContexts.ts";
import * as ThreadContextLayers from "./user/threadContextLayers.ts";
import * as UserContexts from "./user/UserContexts.ts";
import * as GitHub from "./github/GitHub.ts";
import * as GitHubActions from "./github/GitHubActions.ts";
import * as GitHubBranches from "./github/GitHubBranches.ts";
import * as AgentPullRequests from "./github/AgentPullRequests.ts";
import * as CloudPullRequests from "./github/CloudPullRequests.ts";
import * as PullRequestRepository from "./github/PullRequestRepository.ts";
import * as ConnectionLinks from "./connections/ConnectionLinks.ts";
import * as GitHubConnection from "./github/GitHubConnection.ts";
import * as LocalKeys from "./localKeys/LocalKeys.ts";
import type { ExecutorLogins } from "./signIn/ExecutorLogins.ts";
import * as LoginService from "./signIn/LoginService.ts";
import * as SignInGrants from "./signIn/SignInGrants.ts";
import * as LegacySections from "./user/legacySections.ts";
import * as CloudEngine from "./automations/cloudEngine.ts";
import type { AutomationRunner } from "@signalbox/automations/runner/AutomationRunner";
import { makeMemoryWorkflows } from "./automations/memoryWorkflows.ts";
import * as UserFolders from "./user/UserFolders.ts";
import * as FolderStarts from "./user/FolderStarts.ts";
import * as UserDirectory from "./user/UserDirectory.ts";
import * as UserDrives from "./user/UserDrives.ts";
import { makeUserObjectApi } from "./user/userObjectApi.ts";
import * as PoolSignIns from "./user/PoolSignIns.ts";
import * as UserPools from "./user/UserPools.ts";
import * as UserShell from "./user/UserShell.ts";
import * as UserThreadStatus from "./user/UserThreadStatus.ts";
import * as UserStore from "./user/UserStore.ts";
import * as UserModelSettings from "./user/UserModelSettings.ts";
import * as UserKeybindings from "./user/UserKeybindings.ts";
import * as UserAnalyticsPreference from "./user/UserAnalyticsPreference.ts";
import * as UserTimezone from "./user/UserTimezone.ts";
import * as UserThreadKinds from "./user/UserThreadKinds.ts";
import * as ChatArchive from "./user/chatArchive.ts";

/** Test wiring: fixed config, a fake WorkOS, and user objects on in-memory SQLite. */

export const CLOUD_TEST_ENV = {
  ...WORKOS_TEST_ENV,
  ENVIRONMENT_ID: "cloud-test",
  SESSION_SECRET: "test-session-secret-0123456789abcdef",
} as const;

/** The environment the in-memory cloud's API calls act in. */
const API_TEST_IDENTITY = { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" };

/** Fresh per call: Effect shares a layer built once, which would pin the first env. */
export const layerConfig = (env: Readonly<Record<string, string>> = CLOUD_TEST_ENV) =>
  Layer.mergeAll(Layer.fresh(CloudConfig.layer), Layer.fresh(PreviewSetup.layerConfig)).pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  );

/** Attachments over `objects`, with links signed by the test config. */
export const layerAttachments = (objects: AttachmentObjects) =>
  CloudAttachments.layer({ objects, prefix: "" }).pipe(
    Layer.provide(CloudTokens.layer),
    Layer.provide(Layer.mergeAll(layerConfig(), Platform.layerCrypto)),
    Layer.orDie,
  );

/** A user object's storage services on a fresh in-memory database, migrated. */
export const layerMemoryStore = LegacySections.layer.pipe(
  Layer.provideMerge(UserFolders.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      UserStore.layer,
      UserModelSettings.layer,
      UserKeybindings.layer,
      UserAnalyticsPreference.layer,
      UserTimezone.layer,
      UserContexts.layerWithDrives,
      ResourceBindings.layer,
      OnePasswordAccount.layer,
    ),
  ),
  Layer.provideMerge(Layer.effectDiscard(UserStore.migrate)),
  Layer.provideMerge(
    Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" }), Platform.layerCrypto),
  ),
);

/** Places threads for `userId`, who has only Personal, with no storage behind it; no kinds. */
export const layerPersonalThreadContexts = (userId: string) =>
  Layer.succeed(
    ThreadContexts.ThreadContexts,
    ThreadContexts.ThreadContexts.of({
      initialModelSelection: () => Effect.succeed(null),
      placeOfProject: (projectId) => {
        const contextId = contextOfProject([UserContexts.PERSONAL_CONTEXT], projectId);
        return Effect.succeed(
          contextId === null
            ? null
            : { contextId, driveId: myDriveId(contextId, userId), remote: false },
        );
      },
      turn: () =>
        Effect.succeed({
          pools: { top: PERSONAL_POOL_ID, projects: {} },
          instructions: { top: [], projects: {} },
          secrets: { top: [], projects: {} },
        }),
    }),
  ).pipe(Layer.merge(ThreadKindTurns.layerNone));

/** Everyone in a test, findable by email for sharing, with their organizations. */
export type TestPeople = ReadonlyArray<
  DrivePerson & { readonly organizations: ReadonlyArray<string> }
>;

export const layerTestPeople = (people: TestPeople) =>
  Layer.succeed(
    DrivePeople.DrivePeople,
    DrivePeople.DrivePeople.of({
      findByEmail: (email) =>
        Effect.succeed(
          people.find((person) => person.email === email.trim().toLowerCase()) ?? null,
        ),
      organizationsOf: (userId) =>
        Effect.succeed(people.find((person) => person.userId === userId)?.organizations ?? []),
    }),
  );

/**
 * One thread object's engine on SQLite at `filename`. Building the layer again
 * on the same file is what a Durable Object waking after eviction does.
 */
export const layerThreadObject = (
  filename: string,
  machines: Layer.Layer<MachineBackend.MachineBackend> = MachineBackends.layerNone,
  options: {
    readonly drives?: boolean;
    readonly driveDirectory?: Layer.Layer<DriveDirectory.DriveDirectory>;
    /** Whether a thread's owner may change files in its drive; yes unless given. */
    readonly writes?: (
      userId: string,
      driveId: string,
    ) => Effect.Effect<boolean, UserDirectory.UserObjectError>;
    /** Who an owner's commits are by; nobody (the fallback) unless given. */
    readonly commitAuthor?: ThreadRunner.ThreadDrives["Service"]["commitAuthor"];
    /** An owner's 1Password token; none connected unless given. */
    readonly secretsToken?: ThreadRunner.ThreadSecrets["Service"]["token"];
    readonly analytics?: Layer.Layer<
      CloudAnalytics.CloudAnalytics,
      never,
      DiagnosticsStore.DiagnosticsStore | Crypto.Crypto
    >;
    /** Which models turns may start on; any, unless given. */
    readonly models?: Layer.Layer<TurnModels.TurnModels>;
    /** What writes runtime status notes; no model, unless given. */
    readonly statusNoteModel?: Layer.Layer<StatusNoteModel.StatusNoteModel>;
  } = {},
) =>
  ThreadRunner.layer.pipe(
    Layer.provideMerge(ThreadPulls.layerReports.pipe(Layer.provideMerge(ThreadPulls.layer))),
    Layer.provideMerge(options.driveDirectory ?? Layer.empty),
    Layer.provideMerge(
      Layer.succeed(ThreadRunner.ThreadDrives, {
        enabled: options.drives === true,
        writes: options.writes ?? (() => Effect.succeed(true)),
        commitAuthor: options.commitAuthor ?? (() => Effect.succeed(null)),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ThreadRunner.ThreadSecrets, {
        token: options.secretsToken ?? (() => Effect.succeed(null)),
      }),
    ),
    Layer.provideMerge(ThreadBrowsing.layer),
    Layer.provideMerge(
      ThreadStatusNotes.layer.pipe(
        Layer.provide(options.statusNoteModel ?? StatusNoteModel.layerNone),
      ),
    ),
    Layer.provideMerge(ThreadSecretRequests.layer),
    Layer.provideMerge(ThreadEngine.layer),
    Layer.provideMerge(options.models ?? TurnModels.layerUnchecked),
    Layer.provideMerge(Layer.mergeAll(TurnDiagnostics.layer, TurnReports.layer)),
    Layer.provideMerge(options.analytics ?? CloudAnalytics.layerOff),
    Layer.provideMerge(machines),
    Layer.provideMerge(DiagnosticsStore.layer),
    Layer.provideMerge(
      Layer.mergeAll(ThreadStore.layer, SessionRows.layer, PreviewState.layer, PullState.layer),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeSqliteClient.layer({ filename }), Platform.layerCrypto)),
  );

/** A user object's signing keys, as `UserObject` reads them. */
const layerUserObjectTokens = CloudTokens.layerSessionSecret.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: CLOUD_TEST_ENV }))),
  Layer.orDie,
);

/** GitHub with no App and no network, for tests that never reach it. */
const layerNoGitHub = GitHub.layer(null).pipe(Layer.provide(FetchHttpClient.layer));

/** A user object's alarm, recorded: `alarms.get(userId)` is when it would fire next. */
const layerRecordedAlarm = (alarms: Map<string, number>, userId: string) =>
  Layer.succeed(
    CloudAutomations.AutomationAlarm,
    CloudAutomations.AutomationAlarm.of({
      arm: (at) =>
        Effect.sync(() => {
          const current = alarms.get(userId);
          if (at !== null && (current === undefined || at < current)) alarms.set(userId, at);
        }),
    }),
  );

const makeUserRuntime = (
  users: UserDirectory.UserDirectory["Service"],
  threads: ThreadDirectory.ThreadDirectory["Service"],
  pools: PoolDirectory.PoolDirectory["Service"],
  drives: Layer.Layer<DriveDirectory.DriveDirectory | DrivePacks.DrivePacks>,
  people: Layer.Layer<DrivePeople.DrivePeople>,
  github: Layer.Layer<GitHub.GitHub>,
  classifier: Layer.Layer<KindClassifier.KindClassifier>,
  attachments: Layer.Layer<CloudAttachments.CloudAttachments>,
  observe: Layer.Layer<never>,
  alarm: Layer.Layer<CloudAutomations.AutomationAlarm>,
  runner: Layer.Layer<AutomationRunner>,
  /** Replaces the real automations, for tests that watch what they're handed. */
  automations: Layer.Layer<CloudAutomations.CloudAutomations> | Layer.Layer<never>,
  kernel: KernelApi | null,
  logins: { readonly kernel: KernelAuth | null; readonly executor: ExecutorLogins | null },
  noteReader: Layer.Layer<NoteReader.NoteReader>,
  modelCompletion: Layer.Layer<ModelCompletion.ModelCompletion>,
) =>
  ManagedRuntime.make(
    // The user's automations, on the same services the object gives them.
    CloudEngine.layer.pipe(
      Layer.provide(Layer.mergeAll(runner, alarm, modelCompletion)),
      Layer.provideMerge(
        // The same branches the socket's RPC uses, so the git panel sees what the agent pushed.
        Layer.mergeAll(
          GitHubBranches.layer,
          AgentPullRequests.layer,
          GitHubActions.layer,
          CloudPullRequests.layer.pipe(Layer.provideMerge(PullRequestRepository.layer)),
          UserPreviewSetup.layer,
          CloudAssets.layer,
          LoginService.layer(logins),
          UserNotes.layer.pipe(Layer.provide(noteReader)),
        ).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              // Sweeps run when a test asks; nothing arms an alarm here.
              Layer.succeed(LoginService.LoginAlarm, { armBy: () => Effect.void }),
              UserShell.layer,
              UserThreadStatus.layer,
              DriveSharing.layer,
              DriveShortcuts.layer,
              DriveFiles.layer,
              GitHubConnection.layer,
              ConnectionLinks.layer,
              LocalKeys.layer,
              SignInGrants.layer,
              PoolSignIns.layer,
              CloudThreadService.layer.pipe(Layer.provideMerge(ThreadsLive.layer)),
              UserLearner.layer.pipe(Layer.provideMerge(LearnerHomes.layer)),
              PersonBrowsers.layer(kernel),
            ),
          ),
          Layer.provideMerge(
            Layer.mergeAll(
              ThreadContextLayers.layer,
              Platform.layerCrypto,
              UserThreadKinds.layerTurns,
              attachments,
            ),
          ),
          // No push credentials, so phones are recorded and every push is skipped.
          Layer.provideMerge(
            Layer.unwrap(
              Effect.map(UserStore.UserStore, (store) =>
                PushNotifier.layerWithDevices(
                  EnvironmentId.make(CLOUD_TEST_ENV.ENVIRONMENT_ID),
                  (sid) => Effect.map(store.findSession(sid), (session) => session !== null),
                ),
              ),
            ).pipe(
              Layer.provide(
                Layer.mergeAll(
                  FetchHttpClient.layer,
                  ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
                ),
              ),
            ),
          ),
          Layer.provideMerge(
            Layer.mergeAll(UserDrives.layer, UserPools.layer, UserThreadKinds.layer),
          ),
          Layer.provideMerge(Layer.mergeAll(classifier, ChatArchive.layerAlarmNone)),
          Layer.provideMerge(
            Layer.mergeAll(LearnerService.layer, LearnerSummary.layerNone).pipe(
              Layer.provideMerge(LearnerJev.layerNone),
            ),
          ),
          Layer.provideMerge(
            Layer.mergeAll(
              layerMemoryStore,
              ModelCatalog.layer.pipe(Layer.provideMerge(ModelManifest.layerBundled)),
            ),
          ),
          Layer.provideMerge(Layer.mergeAll(drives, people, github)),
          Layer.provideMerge(FolderStarts.layer),
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeed(UserDirectory.UserDirectory, users),
              Layer.succeed(ThreadDirectory.ThreadDirectory, threads),
              Layer.succeed(PoolDirectory.PoolDirectory, pools),
              layerUserObjectTokens,
            ),
          ),
          Layer.provideMerge(observe),
        ),
      ),
      Layer.merge(automations),
    ),
  );

/**
 * The cloud's objects in memory: a user object per user id and a thread
 * object per thread id, running the same APIs the Durable Objects do and
 * reaching each other through the same directories. `settle` does what the
 * thread objects' alarms do: drive every turn to the end and deliver every
 * pending summary and event.
 */
export const makeMemoryCloud = (
  options: {
    readonly people?: TestPeople;
    readonly github?: Layer.Layer<GitHub.GitHub>;
    /** What pools backed by a CLIProxyAPI elsewhere reach. */
    readonly poolFetch?: (request: Request) => Promise<Response>;
    /** Tells chats from tasks; nothing is classified unless given. */
    readonly classifier?: Layer.Layer<KindClassifier.KindClassifier>;
    /** Loggers or a tracer every object here runs with, to see what they log and trace. */
    readonly observe?: Layer.Layer<never>;
    /** Every user object's automations; none unless given, so thread events are dropped. */
    readonly automations?: Layer.Layer<CloudAutomations.CloudAutomations>;
    /** Kernel for every person's browser (#574); none unless given, so it's `unconfigured`. */
    readonly kernel?: KernelApi;
    /** Kernel's Managed Auth and Executor for agents' sign-ins (#576); none unless given. */
    readonly kernelAuth?: KernelAuth;
    readonly executorLogins?: ExecutorLogins;
    /** What reads every user's notes; nothing unless given, so notes stay plain notes. */
    readonly noteReader?: Layer.Layer<NoteReader.NoteReader>;
  } = {},
) => {
  const users = new Map<
    string,
    {
      readonly api: UserDirectory.UserObjectApi;
      readonly runtime: ReturnType<typeof makeUserRuntime>;
    }
  >();
  const threads = new Map<
    string,
    {
      readonly api: ThreadDirectory.ThreadObjectApi;
      readonly run: <A, E>(
        effect: Effect.Effect<
          A,
          E,
          | ThreadEngine.ThreadEngine
          | ThreadStore.ThreadStore
          | UserDirectory.UserDirectory
          | ThreadBrowsing.ThreadBrowsing
          | PullRequestSync.PullRequestSync
          | PullRequestPolls.PullRequestPolls
        >,
      ) => Promise<A>;
    }
  >();
  const mcpHandlers = new Map<string, ReturnType<typeof makeMcpHandler>>();
  const userDirectory: UserDirectory.UserDirectory["Service"] = {
    forUser: (userId) => UserDirectory.handleFor(userFor(userId).api),
    connect: () => Effect.die("Sockets are not part of these tests"),
    // The object's own API and MCP handlers, against its in-memory services.
    callApi: (userId, request, credential) =>
      Effect.promise(async () => {
        const { runtime } = userFor(userId);
        if (new URL(request.url).pathname !== MCP_PATH) {
          return runtime.runPromise(
            serveApiRequest(request, { identity: API_TEST_IDENTITY, userId, credential }),
          );
        }
        const mcp =
          mcpHandlers.get(userId) ??
          makeMcpHandler({
            identity: API_TEST_IDENTITY,
            userId,
            context: await runtime.runPromise(Effect.context()),
          });
        mcpHandlers.set(userId, mcp);
        const headers = new Headers(request.headers);
        headers.set(API_HEADER, encodeApiCredential(credential));
        return mcp.handler(new Request(request, { headers }));
      }),
  };
  const threadDirectory: ThreadDirectory.ThreadDirectory["Service"] = {
    forThread: (threadId) => ThreadDirectory.handleFor(threadFor(threadId).api),
  };
  const pools = makeMemoryPools(options.poolFetch);
  const drives = makeMemoryDrives({ users: () => userDirectory });
  const people = layerTestPeople(options.people ?? []);
  const attachmentObjects = makeMemoryObjects();
  const attachments = layerAttachments(attachmentObjects);
  /** When each user object's alarm would fire next, as its automations armed it. */
  const alarms = new Map<string, number>();
  /** Every user's automation runs, as Workflow instances of the real runtime. */
  const workflows = makeMemoryWorkflows(() => userDirectory);
  /** When each in-memory thread object's alarm would fire next, as a refresh request armed it. */
  const threadAlarms = new Map<string, number>();
  const userFor = (userId: string) => {
    const existing = users.get(userId);
    if (existing) return existing;
    const runtime = makeUserRuntime(
      userDirectory,
      threadDirectory,
      pools.directory,
      drives.layer,
      people,
      options.github ?? layerNoGitHub,
      options.classifier ?? KindClassifier.layerNone,
      attachments,
      options.observe ?? Layer.empty,
      layerRecordedAlarm(alarms, userId),
      workflows.layerFor(userId),
      options.automations ?? Layer.empty,
      options.kernel ?? null,
      { kernel: options.kernelAuth ?? null, executor: options.executorLogins ?? null },
      options.noteReader ?? NoteReader.layerNone,
      ModelCompletion.layer((name) => pools.objectFor(name).api),
    );
    const object = { api: makeUserObjectApi((effect) => runtime.runPromise(effect)), runtime };
    users.set(userId, object);
    return object;
  };
  /** One thread object's services; its linked pull requests sync with `options.github`. */
  const layerThreadObjectInMemory = () =>
    layerThreadObject(":memory:", MachineBackends.layerNone, {
      drives: true,
      driveDirectory: Layer.succeed(DriveDirectory.DriveDirectory, {
        forDrive: (id) => DriveDirectory.handleFor(drives.apiFor(id)),
      }),
      writes: (userId, driveId) =>
        Effect.map(userDirectory.forUser(userId).driveAccess(driveId), canWrite),
      secretsToken: (userId) => userDirectory.forUser(userId).onePasswordToken(),
      // Turns check their pool as in production, with the scripted provider on.
      models: TurnModels.layer({ scripted: true }).pipe(
        Layer.provide(Layer.succeed(PoolDirectory.PoolDirectory, pools.directory)),
      ),
    });
  const threadFor = (threadId: string) => {
    const existing = threads.get(threadId);
    if (existing) return existing;
    const runtime = ManagedRuntime.make(
      PullRequestSync.layer.pipe(
        Layer.provide(options.github ?? layerNoGitHub),
        Layer.provideMerge(layerThreadObjectInMemory()),
        Layer.provideMerge(Layer.succeed(UserDirectory.UserDirectory, userDirectory)),
        Layer.provideMerge(options.observe ?? Layer.empty),
      ),
    );
    const run = <A, E>(
      effect: Effect.Effect<
        A,
        E,
        | ThreadEngine.ThreadEngine
        | ThreadSecretRequests.ThreadSecretRequests
        | ThreadStore.ThreadStore
        | ThreadPulls.ThreadPulls
        | UserDirectory.UserDirectory
        | TurnReports.TurnReports
        | ThreadBrowsing.ThreadBrowsing
        | PullRequestSync.PullRequestSync
        | PullRequestPolls.PullRequestPolls
      >,
    ) => runtime.runPromise(effect);
    // No machine runs in memory, so nothing serves previews.
    const api: ThreadDirectory.ThreadObjectApi = {
      ...makeThreadObjectApi(
        run,
        async () => {},
        async (at) => {
          const current = threadAlarms.get(threadId);
          if (current === undefined || current > at) threadAlarms.set(threadId, at);
        },
      ),
      previews: async () =>
        new ReadableStream({
          start: (c) => c.enqueue(new TextEncoder().encode(`${previewsLine([], false)}\n`)),
        }),
      previewLink: async () => ({ _tag: "unavailable", message: "No machine runs in tests." }),
      browserWatch: async () =>
        new ReadableStream({
          start: (c) =>
            c.enqueue(new TextEncoder().encode(`${browserUpdateLine({ _tag: "offline" })}\n`)),
        }),
      browserInput: async () => ({ _tag: "unavailable", message: "No machine runs in tests." }),
      browserTrail: async () => ({ _tag: "ok", value: [] }),
      browserStep: async () => ({ _tag: "unavailable", message: "No steps in tests." }),
    };
    const object = { api, run };
    threads.set(threadId, object);
    return object;
  };
  const userObject = (userId: string) =>
    Layer.effectContext(Effect.orDie(userFor(userId).runtime.contextEffect));
  const threadService = CloudThreadService.layer.pipe(
    Layer.provideMerge(ThreadsLive.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(UserDirectory.UserDirectory, userDirectory),
        Layer.succeed(ThreadDirectory.ThreadDirectory, threadDirectory),
        attachments,
      ),
    ),
    Layer.provideMerge(Platform.layerCrypto),
  );
  const settleThreads = Effect.promise(async () => {
    for (const { run } of threads.values()) {
      await run(
        Effect.gen(function* () {
          const engine = yield* ThreadEngine.ThreadEngine;
          while (yield* engine.step) {
            // One provider step per alarm in production; here, until the turn ends.
          }
          yield* deliverPendingSummary;
          yield* deliverPendingEvents;
        }),
      );
    }
  });
  /**
   * Turns run to their end and automation runs until they block, twice over:
   * a turn's events start runs, and a run's steps start turns.
   */
  const settle = Effect.gen(function* () {
    for (let round = 0; round < 3; round++) {
      yield* workflows.idle;
      yield* settleThreads;
    }
    yield* workflows.idle;
  });
  return {
    userDirectory,
    threadDirectory,
    /** Runs `effect` in a user object, with its automations. */
    inUser: <A, E>(
      userId: string,
      effect: Effect.Effect<A, E, Layer.Success<typeof CloudEngine.layer>>,
    ) => Effect.promise(() => userFor(userId).runtime.runPromise(effect)),
    inThread: <A, E>(
      threadId: string,
      effect: Effect.Effect<
        A,
        E,
        | ThreadEngine.ThreadEngine
        | ThreadStore.ThreadStore
        | UserDirectory.UserDirectory
        | ThreadBrowsing.ThreadBrowsing
        | PullRequestSync.PullRequestSync
        | PullRequestPolls.PullRequestPolls
      >,
    ) => Effect.promise(() => threadFor(threadId).run(effect)),
    /** The runs' Workflow instances: `idle` lets them run until they block, `advance` moves time. */
    workflows,
    /** When a user object's alarm would fire next; what fired clears it. */
    alarmAt: (userId: string) => alarms.get(userId),
    /** Fires a user object's alarm, as workerd does when it's due. */
    fireAlarm: (userId: string) =>
      Effect.promise(() => {
        alarms.delete(userId);
        return userFor(userId).runtime.runPromise(
          CloudAutomations.CloudAutomations.use((automations) => automations.wake),
        );
      }),
    /** A user object's API as its Durable Object stub answers it, for routes that call stubs. */
    userObjectApi: (userId: string) => userFor(userId).api,
    /** Pool objects by name, each with its fake CLIProxyAPI. */
    pools,
    /** The drives' objects and packs, shared by every user and thread here. */
    drives,
    /** The attachments bucket, shared by every user and thread here. */
    attachmentObjects,
    /** Who owns a thread, and the context and drive it was created in. */
    threadOwner: (threadId: string) =>
      Effect.promise(() =>
        threadFor(threadId).run(ThreadStore.ThreadStore.use((store) => Effect.orDie(store.owner))),
      ),
    /** The 1Password Environments a thread's turns get, top level first. */
    threadSecrets: (threadId: string) =>
      Effect.promise(() =>
        threadFor(threadId).run(
          ThreadStore.ThreadStore.use((store) => Effect.orDie(store.secrets)),
        ),
      ),
    threadSecretEnvironmentNames: (threadId: string) =>
      Effect.promise(() =>
        threadFor(threadId).run(
          ThreadStore.ThreadStore.use((store) => Effect.orDie(store.secretEnvironmentNames)),
        ),
      ),
    /** The next alarm a refresh requested for a thread would arm, for tests. */
    threadAlarmAt: (threadId: string) => threadAlarms.get(threadId),
    /** The in-memory object's clock, for comparing its alarm with its current time. */
    threadNow: (threadId: string) =>
      Effect.promise(() => threadFor(threadId).run(Clock.currentTimeMillis)),
    /** The instructions each of a thread's runs was started with, by run id. */
    runInstructions: (threadId: string, runId: string) =>
      Effect.promise(() =>
        threadFor(threadId).run(
          ThreadStore.ThreadStore.use((store) => Effect.orDie(store.instructions(runId))),
        ),
      ),
    settle,
    /** Every event a thread committed, oldest first. */
    threadEvents: (threadId: string) =>
      Effect.promise(() =>
        threadFor(threadId).run(
          ThreadStore.ThreadStore.use((store) =>
            Effect.map(Effect.orDie(store.events(0)), (stored) =>
              stored.map((entry) => entry.event),
            ),
          ),
        ),
      ),
    /** Time passing for a thread's pull request sync: every link is due again at once. */
    forgetPullRequestPolls: (threadId: string) =>
      Effect.promise(() =>
        threadFor(threadId).run(
          PullRequestPolls.PullRequestPolls.use((polls) => Effect.orDie(polls.replace([]))),
        ),
      ),
    /** What a thread object's alarm does for its linked pull requests; answers when it is due next. */
    syncPullRequests: (threadId: string) =>
      Effect.promise(() =>
        threadFor(threadId).run(PullRequestSync.PullRequestSync.use((sync) => sync.sync)),
      ),
    /** The services inside `userId`'s object, for handlers that run there (the socket's RPC). */
    userObject,
    /** The thread service as `userId`'s object runs it, with that user's contexts. */
    layerFor: (userId: string) =>
      threadService.pipe(
        Layer.provideMerge(ThreadContextLayers.layer),
        Layer.provideMerge(userObject(userId)),
      ),
    /** The thread service for tests where `userId` has only Personal. */
    layerPersonal: (userId: string) =>
      threadService.pipe(Layer.provideMerge(layerPersonalThreadContexts(userId))),
  };
};

const layerMemoryUsers = Layer.sync(
  UserDirectory.UserDirectory,
  () => makeMemoryCloud().userDirectory,
);

/** The sign-in stack with everything it uses exposed for assertions. */
export const layerAccounts = (
  codes: WorkOSCodes,
  env?: Readonly<Record<string, string>>,
  memberships?: WorkOSMemberships,
) =>
  CloudAccounts.layer.pipe(
    Layer.provideMerge(CloudSessions.layer),
    Layer.provideMerge(CloudTokens.layer),
    Layer.provideMerge(IdentityProvider.layer),
    Layer.provideMerge(layerConfig(env)),
    Layer.provideMerge(layerMemoryUsers),
    Layer.provideMerge(workosStubLayer(codes, [], memberships)),
  );
