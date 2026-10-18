import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import { EnvironmentId } from "@t3tools/contracts";
import type { AccountProfile } from "@t3tools/contracts/account";
import { DurableObject } from "cloudflare:workers";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";

import * as CloudAssets from "../assets/CloudAssets.ts";
import * as Evlog from "../observability/Evlog.ts";
import { makeStorageObserver } from "../observability/DurableObjectStorage.ts";
import * as ClientRpcTracing from "../observability/clientRpcTracing.ts";
import * as IdentityProvider from "../account/IdentityProvider.ts";
import * as CloudConfig from "../CloudConfig.ts";
import { AutomationAlarm, CloudAutomations } from "../automations/CloudAutomations.ts";
import * as PersonBrowsers from "../browser/PersonBrowsers.ts";
import * as CloudEngine from "../automations/cloudEngine.ts";
import { layerModelCompletion } from "../models/cloudflare.ts";
import { HookOrigin } from "../automations/cloudIngress.ts";
import { layerWorkflows } from "../automations/workflowRunner.ts";
import { type AttachmentObjects, attachmentStorage } from "../attachments/attachmentObjects.ts";
import * as CloudAttachments from "../attachments/CloudAttachments.ts";
import * as CloudTokens from "../auth/CloudTokens.ts";
import * as DriveDirectory from "../drive/DriveDirectory.ts";
import * as DriveFiles from "../drive/DriveFiles.ts";
import * as DrivePacks from "../drive/DrivePacks.ts";
import * as Environment from "../environment.ts";
import * as GitHub from "../github/GitHub.ts";
import * as GitHubActions from "../github/GitHubActions.ts";
import * as GitHubBranches from "../github/GitHubBranches.ts";
import * as AgentPullRequests from "../github/AgentPullRequests.ts";
import * as CloudPullRequests from "../github/CloudPullRequests.ts";
import * as PullRequestRepository from "../github/PullRequestRepository.ts";
import * as ConnectionLinks from "../connections/ConnectionLinks.ts";
import * as GitHubConnection from "../github/GitHubConnection.ts";
import { API_HEADER, decodeApiCredential, serveApiRequest } from "../api/apiObject.ts";
import { MCP_PATH, makeMcpHandler } from "../api/mcpObject.ts";
import * as LearnerService from "../learner/LearnerService.ts";
import * as LearnerJev from "../learner/LearnerJev.ts";
import * as LearnerSummary from "../learner/LearnerSummary.ts";
import * as LearnerHomes from "./LearnerHomes.ts";
import * as UserLearner from "./UserLearner.ts";
import * as LocalKeys from "../localKeys/LocalKeys.ts";
import * as LoginService from "../signIn/LoginService.ts";
import * as NoteReader from "../notes/NoteReader.ts";
import * as UserNotes from "../notes/UserNotes.ts";
import * as SignInGrants from "../signIn/SignInGrants.ts";
import * as Platform from "../platform.ts";
import * as PoolDirectory from "../pool/PoolDirectory.ts";
import * as UserPreviewSetup from "../previewSetup/UserPreviewSetup.ts";
import * as PushNotifier from "../push/PushNotifier.ts";
import * as ThreadSearchLive from "../search/ThreadSearchLive.ts";
import * as SearchCursors from "../search/SearchCursors.ts";
import { searchSettings } from "../search/searchSettings.ts";
import * as SearchAuthority from "../search/SearchAuthority.ts";
import * as SearchBackfill from "../search/SearchBackfill.ts";
import * as SearchBackfillLive from "../search/SearchBackfillLive.ts";
import * as CloudflareSearchIndex from "../search/CloudflareSearchIndex.ts";
import * as CloudThreadService from "../thread/CloudThreadService.ts";
import * as ThreadsLive from "../thread/ThreadsLive.ts";
import * as ModelManifest from "../models/ModelManifest.ts";
import * as ModelCatalog from "../models/ModelCatalog.ts";
import { scriptedProviderEnabled } from "../thread/scriptedProvider.ts";
import type { MachineBackendEnv } from "../thread/runner/MachineBackend.ts";
import { type PreviewEnv, previewSettings } from "../thread/preview/previewHost.ts";
import { machineSettings } from "../thread/runner/machineBackends.ts";
import * as ThreadDirectory from "../thread/ThreadDirectory.ts";
import * as KindClassifier from "../threadKinds/KindClassifier.ts";
import { ClientSockets, PING, PONG } from "./clientSockets.ts";
import { clientKindOf } from "./clientSessionLog.ts";
import * as PoolSignIns from "./PoolSignIns.ts";
import {
  CONNECTION_HEADER,
  decodeConnectionInfo,
  USER_OBJECT_JURISDICTION,
  type UserObjectApi,
} from "./UserDirectory.ts";
import * as DrivePeople from "./DrivePeople.ts";
import * as DriveSharing from "./DriveSharing.ts";
import * as DriveShortcuts from "./DriveShortcuts.ts";
import * as OnePasswordAccount from "./OnePasswordAccount.ts";
import * as ResourceBindings from "./ResourceBindings.ts";
import * as ThreadContextLayers from "./threadContextLayers.ts";
import * as UserContexts from "./UserContexts.ts";
import * as UserDrives from "./UserDrives.ts";
import { makeUserObjectApi } from "./userObjectApi.ts";
import * as UserPools from "./UserPools.ts";
import * as LegacySections from "./legacySections.ts";
import * as UserFolders from "./UserFolders.ts";
import * as FolderStarts from "./FolderStarts.ts";
import * as UserShell from "./UserShell.ts";
import * as UserStore from "./UserStore.ts";
import * as UserThreadKinds from "./UserThreadKinds.ts";
import * as UserThreadStatus from "./UserThreadStatus.ts";
import * as UserModelSettings from "./UserModelSettings.ts";
import * as UserKeybindings from "./UserKeybindings.ts";
import * as UserAnalyticsPreference from "./UserAnalyticsPreference.ts";
import * as UserTimezone from "./UserTimezone.ts";
import * as ChatArchive from "./chatArchive.ts";
import { makeProfileId } from "./profileId.ts";

/**
 * One per WorkOS user, named by their user id, always in the EU jurisdiction.
 * It owns that user's state (see `UserStore`) and terminates their clients'
 * RPC sockets, reaching their threads through `CloudThreadService`. The Worker
 * authenticates every request before it gets here and forwards a socket's
 * session in `CONNECTION_HEADER`.
 *
 * Client sockets hibernate (`clientSockets.ts`), so an object whose clients
 * are only connected leaves memory and costs nothing until something happens.
 */

export interface UserObjectEnv
  extends
    MachineBackendEnv,
    CloudflareSearchIndex.SearchIndexEnv,
    PreviewEnv,
    GitHub.GitHubEnv,
    LearnerJev.LearnerJevEnv,
    KindClassifier.KindClassifierEnv,
    PersonBrowsers.PersonBrowsersEnv,
    LoginService.LoginServiceEnv {
  /**
   * Drives' objects and packs: clients browse and share them through this
   * object (`drive/DriveFiles.ts`, `DriveSharing.ts`).
   */
  readonly DRIVES?: DriveDirectory.DriveObjectNamespace;
  /** Also where pasted screenshots and files live (`attachments/`). */
  readonly DRIVE_PACKS?: DrivePacks.PackBucket & AttachmentObjects;
  readonly DRIVE_PACKS_PREFIX?: string;
  readonly ENVIRONMENT_ID: string;
  readonly ENVIRONMENT_LABEL?: string;
  readonly AUTOMATION_HOOK_ORIGIN?: string;
  /** Set by `vp run dev` only. Local workerd has no jurisdictions. */
  readonly LOCAL_WORKERD?: string;
  readonly THREADS: ThreadDirectory.ThreadObjectNamespace;
  /** Automation runs, one Workflow instance each (`automations/automationWorkflow.ts`). */
  readonly AUTOMATION_RUNS?: Workflow;
  readonly POOLS: PoolDirectory.PoolObjectNamespace;
  /** `1` in dev and tests: clients may pick the scripted provider (`scriptedProvider.ts`). */
  readonly SCRIPTED_PROVIDER?: string;
  /** The Worker binding that accepts filtered client RPC trace batches. */
  readonly TRACE_EXPORT?: Pick<Fetcher, "fetch">;
  /** Secret shared with the Worker-side trace intake. */
  readonly TRACE_EXPORT_TOKEN?: string;
  readonly SIGNALBOX_DO_STORAGE_ALERT_PERCENT?: string;
  readonly T3CODE_TELEMETRY_ENABLED?: string;
}

const decodeEnvironmentId = Schema.decodeSync(EnvironmentId);

/** Plain string vars and secrets, for the config provider. Bindings are objects. */
const stringVars = (env: UserObjectEnv): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );

/**
 * Drives, when this cloud stores them: their objects and packs (`store`), and
 * browsing and sharing them (`services`). Both use the same `store` layer, so
 * it's built once.
 */
const layerDrives = (env: UserObjectEnv) => {
  const people = Layer.unwrap(
    Effect.map(makeProfileId, (profileId) =>
      DrivePeople.layerForUser(
        profileId.pipe(
          Effect.flatMap((id) =>
            id === null
              ? Effect.fail(
                  new DrivePeople.DrivePeopleError({ message: "Sign in before sharing." }),
                )
              : Effect.succeed(id),
          ),
        ),
      ),
    ),
  ).pipe(Layer.provide(FetchHttpClient.layer));
  if (env.DRIVES === undefined || env.DRIVE_PACKS === undefined) {
    return { store: Layer.empty, services: Layer.empty, people };
  }
  const store = Layer.mergeAll(
    DriveDirectory.layerDurableObjects(env.DRIVES, { localWorkerd: env.LOCAL_WORKERD === "1" }),
    DrivePacks.layerBucket(env.DRIVE_PACKS, env.DRIVE_PACKS_PREFIX),
  );
  return {
    store,
    people,
    services: Layer.mergeAll(DriveSharing.layer, DriveShortcuts.layer, DriveFiles.layer).pipe(
      Layer.provide(Layer.mergeAll(store, people)),
    ),
  };
};

/**
 * Makes the object's alarm go off no later than `atMs`. Its one alarm is
 * shared: the idle-chat sweep (`chatArchive.ts`), client sockets' session
 * expiry and automation crons each only move it earlier, and each treats an
 * early alarm as nothing to do yet.
 */
const armBy = async (storage: DurableObjectStorage, atMs: number) => {
  const current = await storage.getAlarm();
  if (current === null || current > atMs) await storage.setAlarm(atMs);
};

/** Automations' side of the object's alarm: their next cron. */
const layerAutomationAlarm = (storage: DurableObjectStorage) =>
  Layer.succeed(
    AutomationAlarm,
    AutomationAlarm.of({
      arm: (at) => (at === null ? Effect.void : Effect.promise(() => armBy(storage, at))),
    }),
  );

/** The login service's side of the object's alarm: its next re-login sweep (#576). */
const layerLoginAlarm = (storage: DurableObjectStorage) =>
  Layer.succeed(
    LoginService.LoginAlarm,
    LoginService.LoginAlarm.of({ armBy: (atMs) => Effect.promise(() => armBy(storage, atMs)) }),
  );

/** The idle-chat sweep's side of the object's alarm. */
const layerAlarm = (storage: DurableObjectStorage) =>
  Layer.succeed(
    ChatArchive.ChatArchiveAlarm,
    ChatArchive.ChatArchiveAlarm.of({
      armBy: (atMs) => Effect.promise(() => armBy(storage, atMs)),
    }),
  );

// The whole storage, not just `storage.sql`: migrations run in transactions.
const makeRuntime = (ctx: DurableObjectState, env: UserObjectEnv) => {
  const { storage } = ctx;
  const drives = layerDrives(env);
  const searchBackfill = SearchBackfillLive.layer.pipe(
    Layer.provide(
      Layer.succeed(SearchBackfill.SearchBackfillAlarm, {
        by: (at) => Effect.promise(() => armBy(storage, at)),
      }),
    ),
  );
  return ManagedRuntime.make(
    // The user's automations (#434), on the services below.
    CloudEngine.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          layerWorkflows(env.AUTOMATION_RUNS),
          layerAutomationAlarm(storage),
          layerModelCompletion({ pools: env.POOLS }, { localWorkerd: env.LOCAL_WORKERD === "1" }),
          Layer.succeed(HookOrigin, env.AUTOMATION_HOOK_ORIGIN ?? ""),
        ),
      ),
      // Building it only touches the object's own SQLite, which the object can't run without either.
      Layer.orDie,
      Layer.provideMerge(
        Layer.mergeAll(
          GitHubBranches.layer,
          AgentPullRequests.layer,
          GitHubActions.layer,
          CloudPullRequests.layer.pipe(Layer.provideMerge(PullRequestRepository.layer)),
          UserPreviewSetup.layer,
          CloudAssets.layer,
          // Agents' sign-ins (#576): Kernel's Managed Auth, answered from 1Password through Executor.
          LoginService.layerFromEnv(env).pipe(Layer.provide(FetchHttpClient.layer)),
          // Notes (#318), read on each level's pool.
          UserNotes.layer.pipe(
            Layer.provide(
              NoteReader.layer((objectName) =>
                PoolDirectory.poolObjectStub(env.POOLS, objectName, {
                  localWorkerd: env.LOCAL_WORKERD === "1",
                }),
              ),
            ),
          ),
        ).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              UserShell.layer.pipe(Layer.provide(searchBackfill)),
              UserThreadStatus.layer,
              CloudThreadService.layer.pipe(Layer.provideMerge(ThreadsLive.layer)),
              ThreadSearchLive.layer.pipe(
                Layer.provide(Layer.mergeAll(SearchAuthority.layerUser, SearchCursors.layerSql)),
                Layer.provideMerge(searchBackfill),
              ),
              UserLearner.layer.pipe(Layer.provideMerge(LearnerHomes.layer)),
              PoolSignIns.layer,
              drives.services,
              ConnectionLinks.layer,
              LocalKeys.layer,
              SignInGrants.layer,
            ),
          ),
          // Below the drive services: the files panel reads promised files with it (#406).
          Layer.provideMerge(GitHubConnection.layer),
          Layer.provideMerge(
            Layer.mergeAll(
              ThreadContextLayers.layer.pipe(Layer.provideMerge(UserPools.layer)),
              UserThreadKinds.layerTurns,
              // The person's browser for real sites (#574), on Kernel.
              PersonBrowsers.layerFromEnv(env).pipe(Layer.provide(FetchHttpClient.layer)),
              // Pasted screenshots and files, signed with the same keys as asset URLs.
              CloudAttachments.layer(attachmentStorage(env)),
            ),
          ),
          Layer.provideMerge(UserThreadKinds.layer),
          Layer.provideMerge(
            Layer.mergeAll(
              KindClassifier.layerFromEnv(env).pipe(Layer.provide(FetchHttpClient.layer)),
              layerAlarm(storage),
              layerLoginAlarm(storage),
              Layer.unwrap(
                Effect.map(UserStore.UserStore, (store) =>
                  PushNotifier.layerWithDevices(decodeEnvironmentId(env.ENVIRONMENT_ID), (sid) =>
                    Effect.map(store.findSession(sid), (session) => session !== null),
                  ),
                ),
              ).pipe(
                Layer.provide(
                  Layer.mergeAll(
                    FetchHttpClient.layer,
                    ConfigProvider.layer(ConfigProvider.fromEnv({ env: stringVars(env) })),
                  ),
                ),
              ),
            ),
          ),
          Layer.provideMerge(LegacySections.layer),
          Layer.provideMerge(UserFolders.layer),
          Layer.provideMerge(FolderStarts.layer),
          Layer.provideMerge(
            Layer.mergeAll(
              LearnerService.layer,
              LearnerSummary.layer((objectName) =>
                PoolDirectory.poolObjectStub(env.POOLS, objectName, {
                  localWorkerd: env.LOCAL_WORKERD === "1",
                }),
              ),
            ).pipe(
              Layer.provideMerge(
                LearnerJev.layerFromEnv(env).pipe(Layer.provide(FetchHttpClient.layer)),
              ),
            ),
          ),
          Layer.provideMerge(ModelCatalog.layer.pipe(Layer.provideMerge(ModelManifest.layer))),
          Layer.provideMerge(
            GitHub.layerForUsers(GitHub.gitHubEndpoints(env)).pipe(
              Layer.provide(FetchHttpClient.layer),
            ),
          ),
          Layer.provideMerge(CloudflareSearchIndex.layerFromEnv(env)),
          Layer.provideMerge(UserDrives.layer),
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
          Layer.provideMerge(Layer.mergeAll(drives.store, drives.people)),
          Layer.provideMerge(
            Layer.mergeAll(
              ThreadDirectory.layerDurableObjects(env.THREADS, {
                localWorkerd: env.LOCAL_WORKERD === "1",
              }),
              PoolDirectory.layerDurableObjects(env.POOLS, {
                localWorkerd: env.LOCAL_WORKERD === "1",
              }),
            ),
          ),
          Layer.provideMerge(
            Layer.mergeAll(
              SqliteClient.layer({ storage }),
              Platform.layerCrypto,
              Evlog.layer,
              Evlog.layerWaitUntil(ctx),
            ),
          ),
          Layer.provideMerge(
            IdentityProvider.layer.pipe(
              Layer.provide(CloudConfig.layer),
              Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: stringVars(env) }))),
              Layer.orDie,
            ),
          ),
          // Signs asset URLs (`CloudAssets`) with the Worker's keys, from the same vars.
          Layer.provideMerge(
            CloudTokens.layerSessionSecret.pipe(
              Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: stringVars(env) }))),
              Layer.orDie,
            ),
          ),
          Layer.provideMerge(ClientRpcTracing.layer(env, (promise) => ctx.waitUntil(promise))),
        ),
      ),
    ),
  );
};

export class UserObject extends DurableObject<UserObjectEnv> implements UserObjectApi {
  private readonly runtime: ReturnType<typeof makeRuntime>;
  private readonly identity: Environment.CloudEnvironmentIdentity;
  /** The person's MCP server (`api/mcpObject.ts`), made on first use. */
  private mcp: ReturnType<typeof makeMcpHandler> | undefined;
  private readonly sockets: ClientSockets;
  private readonly observeStorage: () => void;

  constructor(ctx: DurableObjectState, env: UserObjectEnv) {
    super(ctx, env);
    // Created only through `jurisdiction("eu")`; anything else is a routing bug
    // that must not quietly store a user's data elsewhere.
    if (env.LOCAL_WORKERD !== "1" && ctx.id.jurisdiction !== USER_OBJECT_JURISDICTION) {
      throw new Error("User objects must live in the EU jurisdiction.");
    }
    // Decoded like the Worker's `CloudConfig`, from the same vars.
    this.identity = {
      environmentId: decodeEnvironmentId(env.ENVIRONMENT_ID),
      label: env.ENVIRONMENT_LABEL ?? Environment.DEFAULT_ENVIRONMENT_LABEL,
      // Only machines run dev servers.
      previews: machineSettings(env) !== null && previewSettings(env) !== null,
      scripted: scriptedProviderEnabled(env),
      attachments: env.DRIVE_PACKS !== undefined,
      searchDisabled: searchSettings(env).disabled,
    };
    this.runtime = makeRuntime(ctx, env);
    this.observeStorage = makeStorageObserver(ctx, { kind: "user", level: "person" }, env);
    this.sockets = new ClientSockets({
      ctx,
      identity: this.identity,
      run: (effect) => this.runtime.runPromise(effect).finally(() => this.observeStorage()),
    });
    // Client keepalives are answered without waking a hibernating object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    void ctx.blockConcurrencyWhile(async () => {
      await this.runtime.runPromise(UserStore.migrate);
      this.observeStorage();
      await armBy(ctx.storage, (await this.now()) + 1_000);
      // Serves sockets that outlived the object's memory before anything else runs.
      await this.sockets.restore(await this.now(), (await this.profile())?.id);
      // An alarm lost to a crash between sweeps is set again; one that's set is enough.
      if ((await ctx.storage.getAlarm()) === null) {
        await this.runtime.runPromise(
          UserThreadKinds.UserThreadKinds.use((kinds) => kinds.arm).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("arming the idle-chat sweep failed", { cause }),
            ),
          ),
        );
      }
      // Then automations give cut-off launches their instance and set the alarm for the next cron.
      await this.runtime.runPromise(
        CloudAutomations.use((automations) => automations.start).pipe(
          Effect.catchCause((cause) => Effect.logError("starting automations failed", { cause })),
        ),
      );
    });
  }

  private now() {
    return this.runtime.runPromise(Clock.currentTimeMillis);
  }

  private readonly api: UserObjectApi = makeUserObjectApi((effect) =>
    this.runtime.runPromise(effect).finally(() => this.observeStorage()),
  );

  // Durable Object RPC dispatches to prototype methods, so each one is spelled out.
  async recordSignIn(profile: AccountProfile) {
    await this.api.recordSignIn(profile);
    await armBy(this.ctx.storage, (await this.now()) + 1_000);
  }

  searchThreads(...args: Parameters<UserObjectApi["searchThreads"]>) {
    return this.api.searchThreads(...args);
  }

  readSearchItem(...args: Parameters<UserObjectApi["readSearchItem"]>) {
    return this.api.readSearchItem(...args);
  }

  profile() {
    return this.api.profile();
  }

  createSession(input: Parameters<UserObjectApi["createSession"]>[0]) {
    return this.api.createSession(input);
  }

  findSession(sid: string) {
    return this.api.findSession(sid);
  }

  async revokeSession(sid: string) {
    const revoked = await this.api.revokeSession(sid);
    await this.sockets.revoke(sid);
    return revoked;
  }

  issueGrant(input: Parameters<UserObjectApi["issueGrant"]>[0]) {
    return this.api.issueGrant(input);
  }

  redeemHandoff(input: Parameters<UserObjectApi["redeemHandoff"]>[0]) {
    return this.api.redeemHandoff(input);
  }

  exchangeCredential(input: Parameters<UserObjectApi["exchangeCredential"]>[0]) {
    return this.api.exchangeCredential(input);
  }

  syncOrganizations(organizations: Parameters<UserObjectApi["syncOrganizations"]>[0]) {
    return this.api.syncOrganizations(organizations);
  }

  shellSnapshot() {
    return this.api.shellSnapshot();
  }

  recordThreadSummary(summary: unknown) {
    return this.api.recordThreadSummary(summary);
  }

  rebuildThreadIndex() {
    return this.api.rebuildThreadIndex();
  }

  beginGitHubConnect(input: Parameters<UserObjectApi["beginGitHubConnect"]>[0]) {
    return this.api.beginGitHubConnect(input);
  }

  completeGitHubConnect(grantId: string) {
    return this.api.completeGitHubConnect(grantId);
  }

  abortGitHubConnect(grantId: string) {
    return this.api.abortGitHubConnect(grantId);
  }

  disconnectGitHub() {
    return this.api.disconnectGitHub();
  }

  githubAccessToken() {
    return this.api.githubAccessToken();
  }

  createConnectionLink(label: string) {
    return this.api.createConnectionLink(label);
  }

  connectionLinks() {
    return this.api.connectionLinks();
  }

  revokeConnectionLink(id: string) {
    return this.api.revokeConnectionLink(id);
  }

  linkedConnections(secret: string) {
    return this.api.linkedConnections(secret);
  }

  linkedToken(input: Parameters<UserObjectApi["linkedToken"]>[0]) {
    return this.api.linkedToken(input);
  }

  createLocalKey(label: string, options?: LocalKeys.KeyOptions) {
    return this.api.createLocalKey(label, options);
  }

  localKeys() {
    return this.api.localKeys();
  }

  revokeLocalKey(id: string) {
    return this.api.revokeLocalKey(id);
  }

  authorizeLocalModel(secret: string) {
    return this.api.authorizeLocalModel(secret);
  }

  recordLocalModelRequest(input: Parameters<UserObjectApi["recordLocalModelRequest"]>[0]) {
    return this.api.recordLocalModelRequest(input);
  }

  issuePreviewSetupCode(input: Parameters<UserObjectApi["issuePreviewSetupCode"]>[0]) {
    return this.api.issuePreviewSetupCode(input);
  }

  redeemPreviewSetup(input: Parameters<UserObjectApi["redeemPreviewSetup"]>[0]) {
    return this.api.redeemPreviewSetup(input);
  }

  importPreviewSetup(input: Parameters<UserObjectApi["importPreviewSetup"]>[0]) {
    return this.api.importPreviewSetup(input);
  }

  githubCommitAuthor() {
    return this.api.githubCommitAuthor();
  }

  pullRequestDiff(input: Parameters<UserObjectApi["pullRequestDiff"]>[0]) {
    return this.api.pullRequestDiff(input);
  }

  onePasswordToken() {
    return this.api.onePasswordToken();
  }

  contextIds() {
    return this.api.contextIds();
  }

  clientTraceDimensions(threadIds: Parameters<UserObjectApi["clientTraceDimensions"]>[0]) {
    return this.api.clientTraceDimensions(threadIds);
  }

  clientFolderDimensions(folderIds: Parameters<UserObjectApi["clientFolderDimensions"]>[0]) {
    return this.api.clientFolderDimensions(folderIds);
  }

  recordDriveAccess(entry: Parameters<UserObjectApi["recordDriveAccess"]>[0]) {
    return this.api.recordDriveAccess(entry);
  }

  driveAccess(driveId: string) {
    return this.api.driveAccess(driveId);
  }

  readableDrives() {
    return this.api.readableDrives();
  }

  publishBranch(input: Parameters<UserObjectApi["publishBranch"]>[0]) {
    return this.api.publishBranch(input);
  }

  threadEvents(input: Parameters<UserObjectApi["threadEvents"]>[0]) {
    return this.api.threadEvents(input);
  }

  driveEvents(input: Parameters<UserObjectApi["driveEvents"]>[0]) {
    return this.api.driveEvents(input);
  }

  learnerTool(threadId: string, name: string, input: unknown) {
    return this.api.learnerTool(threadId, name, input);
  }

  automationTool(threadId: string, name: string, input: unknown) {
    return this.api.automationTool(threadId, name, input);
  }

  folderStatus(threadId: string) {
    return this.api.folderStatus(threadId);
  }

  browserSession(input: Parameters<UserObjectApi["browserSession"]>[0]) {
    return this.api.browserSession(input);
  }

  browserSignIn(input: Parameters<UserObjectApi["browserSignIn"]>[0]) {
    return this.api.browserSignIn(input);
  }

  checkSignIn(input: Parameters<UserObjectApi["checkSignIn"]>[0]) {
    return this.api.checkSignIn(input);
  }

  authorizeExecutorToken(...args: Parameters<UserObjectApi["authorizeExecutorToken"]>) {
    return this.api.authorizeExecutorToken(...args);
  }

  endBrowser(input: Parameters<UserObjectApi["endBrowser"]>[0]) {
    return this.api.endBrowser(input);
  }

  automationHost(call: Parameters<UserObjectApi["automationHost"]>[0]) {
    return this.api.automationHost(call);
  }

  receiveHook(request: Parameters<UserObjectApi["receiveHook"]>[0]) {
    return this.api.receiveHook(request);
  }

  automationWorkerModule(automationId: string, version: number) {
    return this.api.automationWorkerModule(automationId, version);
  }

  sweepThreadKinds(asOfMs: number) {
    return this.api.sweepThreadKinds(asOfMs);
  }

  override async fetch(request: Request): Promise<Response> {
    this.observeStorage();
    const apiCredential = decodeApiCredential(request.headers.get(API_HEADER));
    if (apiCredential._tag === "Some") {
      const profile = await this.profile();
      if (!profile) return new Response("Unauthorized", { status: 401 });
      if (new URL(request.url).pathname === MCP_PATH) {
        // One MCP server per object: its sessions last as long as the object does.
        this.mcp ??= makeMcpHandler({
          identity: this.identity,
          userId: profile.id,
          context: await this.runtime.runPromise(Effect.context()),
        });
        return this.mcp.handler(request);
      }
      return this.runtime.runPromise(
        serveApiRequest(request, {
          identity: this.identity,
          userId: profile.id,
          credential: apiCredential.value,
        }),
      );
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    // The Worker checked only the token's signature; the record is the authority.
    const { sid } = decodeConnectionInfo(request.headers.get(CONNECTION_HEADER));
    const session = await this.findSession(sid);
    const profile = await this.profile();
    if (!session || !profile) return new Response("Unauthorized", { status: 401 });

    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    await this.sockets.accept(
      server,
      session,
      profile.id,
      clientKindOf(new URL(request.url).searchParams.get("clientSurface")),
    );
    // The alarm disconnects it when its session expires.
    await armBy(this.ctx.storage, session.expiresAt);
    // A revoke that landed while the socket was being set up missed it.
    if (!(await this.findSession(sid))) await this.sockets.revoke(sid);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    await this.sockets.message(socket, message);
  }

  override async webSocketClose(socket: WebSocket, code: number, reason: string) {
    await this.sockets.closed(socket, code, reason);
  }

  override async webSocketError(socket: WebSocket) {
    await this.sockets.closed(socket, 1011, "", "error");
  }

  /**
   * Expired sessions' sockets close, idle chats archive themselves
   * (`UserThreadKinds`), due crons start, and sites Kernel found logged out
   * are logged in again (`LoginService`). Each re-arms it.
   */
  override async alarm() {
    this.observeStorage();
    const next = await this.sockets.expire(await this.now());
    if (next !== null) await armBy(this.ctx.storage, next);
    await this.runtime.runPromise(
      Effect.all(
        [
          SearchBackfill.SearchBackfill.use((backfill) => backfill.step),
          UserThreadKinds.UserThreadKinds.use((kinds) => kinds.alarm).pipe(
            Effect.catchCause((cause) => Effect.logError("idle-chat sweep failed", { cause })),
          ),
          CloudAutomations.use((automations) => automations.wake).pipe(
            Effect.catchCause((cause) => Effect.logError("automation crons failed", { cause })),
          ),
          LoginService.LoginService.use((logins) => logins.sweep).pipe(
            Effect.catchCause((cause) => Effect.logError("re-login sweep failed", { cause })),
          ),
        ],
        { discard: true },
      ).pipe(
        // Named by the person's user id (`UserDirectory`).
        Evlog.withUnit(
          "user.alarm",
          this.ctx.id.name === undefined ? {} : { person: { id: this.ctx.id.name } },
        ),
      ),
    );
  }
}
