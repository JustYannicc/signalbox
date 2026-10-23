import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import {
  ThreadId,
  type ModelSelection,
  type OrchestrationV2DispatchCommandResult,
  type OrchestrationV2ThreadLaunchInput,
} from "@t3tools/contracts";
import { PERSONAL_POOL_ID } from "@t3tools/contracts/accountHub";
import type { AccountProfile } from "@t3tools/contracts/account";
import { DurableObject, type RpcStub, type RpcTarget } from "cloudflare:workers";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as CloudAttachments from "../attachments/CloudAttachments.ts";
import { attachmentStorage } from "../attachments/attachmentObjects.ts";
import * as CloudTokens from "../auth/CloudTokens.ts";
import * as Platform from "../platform.ts";
import type { LocalPoolCapabilityApi } from "../pool/LocalPoolCapability.ts";
import * as PoolDirectory from "../pool/PoolDirectory.ts";
import * as PoolEngine from "../pool/PoolEngine.ts";
import type { Actor } from "../thread/ThreadAccess.ts";
import * as ThreadDirectory from "../thread/ThreadDirectory.ts";
import type { ThreadCommandObjectApi } from "../thread/ThreadCommandApi.ts";
import * as Threads from "../thread/Threads.ts";
import * as ThreadsLive from "../thread/ThreadsLive.ts";
import { commandThreadId } from "../thread/threadDecider.ts";
import { encodeBatchLine, wire } from "../thread/threadWire.ts";
import { makeUserThreadOperations, userThreadWire } from "./ThreadOperations.ts";
import {
  LocalUserCapability,
  type LocalUserCapabilityApi,
  type LocalUserCapabilityMethods,
} from "./LocalUserCapability.ts";
import { createLocalUser, initializeLocalUserProfile } from "./LocalUser.ts";
import * as ChatArchive from "./chatArchive.ts";

const OWNER_KEY = "local-user-owner-v1";
const CONFIGURATION_KEY = "local-user-configuration-v1";
const SESSION_SECRET_KEY = "local-user-session-secret-v1";
const REJECTED_POOL_REASON = "This local pool only exposes its owner's Personal pool.";

const rejectedPoolHandle: PoolDirectory.PoolHandle = {
  create: () => Effect.fail(new PoolEngine.PoolRejectedError({ reason: REJECTED_POOL_REASON })),
  info: () => Effect.fail(new PoolEngine.PoolRejectedError({ reason: REJECTED_POOL_REASON })),
  rename: () => Effect.fail(new PoolEngine.PoolRejectedError({ reason: REJECTED_POOL_REASON })),
  setRouting: () => Effect.fail(new PoolEngine.PoolRejectedError({ reason: REJECTED_POOL_REASON })),
  setBacking: () => Effect.fail(new PoolEngine.PoolRejectedError({ reason: REJECTED_POOL_REASON })),
  delete: () => Effect.fail(new PoolEngine.PoolRejectedError({ reason: REJECTED_POOL_REASON })),
  accounts: () => Effect.fail(new PoolEngine.PoolRejectedError({ reason: REJECTED_POOL_REASON })),
  advice: () => Effect.fail(new PoolEngine.PoolRejectedError({ reason: REJECTED_POOL_REASON })),
  models: () => Effect.fail(new PoolEngine.PoolRejectedError({ reason: REJECTED_POOL_REASON })),
  startLogin: () => Effect.fail(new PoolEngine.PoolRejectedError({ reason: REJECTED_POOL_REASON })),
  loginStatus: () =>
    Effect.fail(new PoolEngine.PoolRejectedError({ reason: REJECTED_POOL_REASON })),
  completeLogin: () =>
    Effect.fail(new PoolEngine.PoolRejectedError({ reason: REJECTED_POOL_REASON })),
  cancelLogin: () =>
    Effect.fail(new PoolEngine.PoolRejectedError({ reason: REJECTED_POOL_REASON })),
  logoutAccount: () =>
    Effect.fail(new PoolEngine.PoolRejectedError({ reason: REJECTED_POOL_REASON })),
  updateAccount: () =>
    Effect.fail(new PoolEngine.PoolRejectedError({ reason: REJECTED_POOL_REASON })),
  openLink: () => Effect.fail(new PoolEngine.PoolRejectedError({ reason: REJECTED_POOL_REASON })),
};

type LocalThreadCommandCapabilityApi = RpcTarget & ThreadCommandObjectApi;

export interface LocalUserConfiguration {
  readonly threadId: string;
  readonly modelSelection: ModelSelection;
}

interface StoredConfiguration extends LocalUserConfiguration {
  readonly ownerId: string;
}

type LocalUserDomain = Effect.Success<ReturnType<typeof createLocalUser>>;
type LocalUserCatalog = Effect.Success<LocalUserDomain["catalog"]>;
type LocalUserHome = Effect.Success<LocalUserDomain["home"]>;

const configurationKey = (configuration: StoredConfiguration) => JSON.stringify(configuration);

/** Client-side shape of the local user Durable Object and its thread capability. */
export interface LocalUserObjectApi extends LocalUserCapabilityMethods {
  readonly initialize: () => Promise<AccountProfile>;
  readonly configure: (
    configuration: LocalUserConfiguration,
    pool: RpcStub<LocalPoolCapabilityApi>,
    thread: RpcStub<LocalThreadCommandCapabilityApi>,
  ) => Promise<void>;
  readonly capability: () => Promise<RpcStub<LocalUserCapabilityApi>>;
  readonly catalog: () => Promise<LocalUserCatalog>;
  readonly home: () => Promise<LocalUserHome>;
  readonly refreshPools: () => Promise<void>;
  readonly launch: (input: unknown) => Promise<unknown>;
  readonly dispatch: (command: unknown) => Promise<OrchestrationV2DispatchCommandResult>;
  readonly snapshot: (threadId: string) => Promise<unknown>;
  readonly subscribe: (input: unknown) => Promise<ReadableStream<Uint8Array>>;
  readonly dispose: () => Promise<void>;
}

/** Hosts one real local user domain and routes commands through its product thread service. */
export class LocalUserObject extends DurableObject<unknown> implements LocalUserCapabilityMethods {
  private owner: AccountProfile | undefined;
  private configuration: StoredConfiguration | undefined;
  private user: LocalUserDomain | undefined;
  private threads: Threads.Threads["Service"] | undefined;
  private scope: Scope.Closeable | undefined;
  private pool: RpcStub<LocalPoolCapabilityApi> | undefined;
  private thread: RpcStub<LocalThreadCommandCapabilityApi> | undefined;
  private closed = false;

  async initialize() {
    return this.ctx.blockConcurrencyWhile(() => this.ensureOwner());
  }

  async configure(
    configuration: LocalUserConfiguration,
    pool: RpcStub<LocalPoolCapabilityApi>,
    thread: RpcStub<LocalThreadCommandCapabilityApi>,
  ) {
    return this.ctx.blockConcurrencyWhile(async () => {
      this.assertOpen();
      const owner = await this.ensureOwner();
      const identity: StoredConfiguration = {
        ...configuration,
        threadId: ThreadId.make(configuration.threadId),
        ownerId: owner.id,
      };
      const key = configurationKey(identity);
      const previous = await this.ctx.storage.get<StoredConfiguration>(CONFIGURATION_KEY);
      if (previous !== undefined && configurationKey(previous) !== key) {
        throw new Error("This local user storage belongs to another owner, model, or thread.");
      }
      if (this.configuration !== undefined) {
        if (configurationKey(this.configuration) !== key) {
          throw new Error("A local user cannot be rebound to another owner, model, or thread.");
        }
        return;
      }

      await this.ctx.storage.put(CONFIGURATION_KEY, identity);
      const heldPool = pool.dup();
      const heldThread = thread.dup();
      const personalPoolObjectName = PoolDirectory.poolObjectName(owner.id, PERSONAL_POOL_ID);
      const scope = Effect.runSync(Scope.make());
      this.pool = heldPool;
      this.thread = heldThread;
      this.scope = scope;
      this.configuration = identity;

      try {
        const localUser = await Effect.runPromise(
          createLocalUser({
            sql: SqliteClient.layer({ storage: this.ctx.storage }),
            chatArchiveAlarm: Layer.succeed(
              ChatArchive.ChatArchiveAlarm,
              ChatArchive.ChatArchiveAlarm.of({
                armBy: (atMs) => Effect.promise(() => this.ctx.storage.setAlarm(atMs)),
              }),
            ),
            pools: (ownerId) =>
              ownerId === owner.id
                ? Effect.succeed(
                    PoolDirectory.PoolDirectory.of({
                      forPool: (objectName) =>
                        objectName === personalPoolObjectName
                          ? PoolDirectory.handleFor(heldPool)
                          : rejectedPoolHandle,
                    }),
                  )
                : Effect.fail(
                    new PoolEngine.PoolRejectedError({
                      reason: "The local pool owner does not match the user.",
                    }),
                  ),
          }).pipe(Scope.provide(scope)),
        );
        if (localUser.profile.id !== owner.id) {
          throw new Error("The local user profile changed while its domain was configured.");
        }

        const threadDirectory = ThreadDirectory.commandDirectory(
          ThreadId.make(identity.threadId),
          heldThread,
        );
        await Effect.runPromise(localUser.ready(threadDirectory));

        const sessionSecret = await this.localSessionSecret();
        const tokens = CloudTokens.layerSessionSecret.pipe(
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({ env: { SESSION_SECRET: sessionSecret } }),
            ),
          ),
        );
        const attachments = CloudAttachments.layer(attachmentStorage({})).pipe(
          Layer.provide(Layer.mergeAll(tokens, Platform.layerCrypto)),
        );
        const runtime = Layer.mergeAll(
          localUser.platform,
          Layer.succeed(ThreadDirectory.ThreadDirectory, threadDirectory),
          attachments,
          Platform.layerCrypto,
        );
        const threadContext = await Effect.runPromise(
          Layer.build(ThreadsLive.layer.pipe(Layer.provide(runtime))).pipe(Scope.provide(scope)),
        );

        this.user = localUser;
        this.threads = Context.get(threadContext, Threads.Threads);
      } catch (error) {
        this.configuration = undefined;
        this.user = undefined;
        this.threads = undefined;
        this.scope = undefined;
        this.releaseCapabilities();
        await Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => undefined);
        throw error;
      }
    });
  }

  capability(): LocalUserCapabilityApi {
    return new LocalUserCapability(this);
  }

  async getActor() {
    const { user } = this.configured();
    return Effect.runPromise(user.actor);
  }

  async profile() {
    const { user, owner } = this.configured();
    return Effect.runPromise(user.directory.forUser(owner.id).profile());
  }

  async githubCommitAuthor() {
    const { user, owner } = this.configured();
    return Effect.runPromise(user.directory.forUser(owner.id).githubCommitAuthor());
  }

  async onePasswordToken() {
    const { user, owner } = this.configured();
    return Effect.runPromise(user.directory.forUser(owner.id).onePasswordToken());
  }

  async contextIds() {
    const { user, owner } = this.configured();
    return Effect.runPromise(user.directory.forUser(owner.id).contextIds());
  }

  async driveAccess(driveId: string) {
    const { user, owner } = this.configured();
    return Effect.runPromise(user.directory.forUser(owner.id).driveAccess(driveId));
  }

  async readableDrives() {
    const { user, owner } = this.configured();
    return Effect.runPromise(user.directory.forUser(owner.id).readableDrives());
  }

  async recordThreadSummary(summary: unknown) {
    const { user, configuration } = this.configured();
    const decoded = wire.summary.decode(summary);
    this.assertThread(decoded.threadId, configuration);
    await Effect.runPromise(user.recordSummary(decoded));
  }

  async dispatchContinuation(actor: Actor, command: unknown) {
    const { user, owner, configuration, threads } = this.configured();
    const currentActor = await Effect.runPromise(user.actor);
    if (
      actor.userId !== owner.id ||
      actor.userId !== currentActor.userId ||
      actor.contextIds.some((id) => !currentActor.contextIds.includes(id))
    ) {
      throw new Error("The continuation actor is outside the current local user context.");
    }
    const decoded = userThreadWire.command.decode(command);
    this.assertThread(commandThreadId(decoded), configuration);
    return Effect.runPromise(makeUserThreadOperations(threads, currentActor).dispatch(decoded));
  }

  async catalog() {
    const { user } = this.configured();
    return Effect.runPromise(user.catalog);
  }

  async home() {
    const { user } = this.configured();
    return Effect.runPromise(user.home);
  }

  async refreshPools() {
    const { user } = this.configured();
    await Effect.runPromise(user.refreshPools);
  }

  async launch(input: unknown) {
    const { user, configuration, threads } = this.configured();
    const decoded = userThreadWire.launchInput.decode(input);
    if (decoded.threadId !== undefined && decoded.threadId !== configuration.threadId) {
      throw new Error("The launch targets another local thread.");
    }
    const launch: OrchestrationV2ThreadLaunchInput = {
      ...decoded,
      threadId: ThreadId.make(configuration.threadId),
    };
    const actor = await Effect.runPromise(user.actor);
    const result = await Effect.runPromise(makeUserThreadOperations(threads, actor).launch(launch));
    return wire.launchResult.encode(result);
  }

  async dispatch(command: unknown): Promise<OrchestrationV2DispatchCommandResult> {
    const { user, configuration, threads } = this.configured();
    const decoded = userThreadWire.command.decode(command);
    this.assertThread(commandThreadId(decoded), configuration);
    const actor = await Effect.runPromise(user.actor);
    return Effect.runPromise(makeUserThreadOperations(threads, actor).dispatch(decoded));
  }

  async snapshot(threadId: string) {
    const { user, configuration, threads } = this.configured();
    this.assertThread(ThreadId.make(threadId), configuration);
    const actor = await Effect.runPromise(user.actor);
    const snapshot = await Effect.runPromise(
      makeUserThreadOperations(threads, actor).snapshot(ThreadId.make(threadId)),
    );
    return wire.snapshot.encode(snapshot);
  }

  async subscribe(input: unknown) {
    const { user, configuration, threads } = this.configured();
    const decoded = wire.subscribeInput.decode(input);
    this.assertThread(decoded.threadId, configuration);
    const actor = await Effect.runPromise(user.actor);
    return makeUserThreadOperations(threads, actor)
      .subscribe(decoded)
      .pipe(Stream.map(encodeBatchLine), Stream.toReadableStream());
  }

  override async alarm() {
    const { user } = this.configured();
    await Effect.runPromise(user.alarm);
  }

  async dispose() {
    if (this.closed) return;
    this.closed = true;
    const scope = this.scope;
    this.scope = undefined;
    this.user = undefined;
    this.threads = undefined;
    this.configuration = undefined;
    try {
      if (scope !== undefined) await Effect.runPromise(Scope.close(scope, Exit.void));
    } finally {
      this.releaseCapabilities();
    }
  }

  private async ensureOwner() {
    this.assertOpen();
    const profile =
      this.owner ??
      (await Effect.runPromise(
        initializeLocalUserProfile({ sql: SqliteClient.layer({ storage: this.ctx.storage }) }),
      ));
    const storedOwnerId = await this.ctx.storage.get<string>(OWNER_KEY);
    if (storedOwnerId !== undefined && storedOwnerId !== profile.id) {
      throw new Error("This local user storage belongs to another owner.");
    }
    if (storedOwnerId === undefined) await this.ctx.storage.put(OWNER_KEY, profile.id);
    this.owner = profile;
    return profile;
  }

  private configured() {
    this.assertOpen();
    if (
      this.user === undefined ||
      this.threads === undefined ||
      this.configuration === undefined ||
      this.owner === undefined
    ) {
      throw new Error("The local user object is not configured.");
    }
    return {
      user: this.user,
      threads: this.threads,
      configuration: this.configuration,
      owner: this.owner,
    };
  }

  private assertThread(threadId: string | null, configuration: StoredConfiguration) {
    if (threadId !== configuration.threadId) {
      throw new Error("The operation targets another local thread.");
    }
  }

  private assertOpen() {
    if (this.closed) throw new Error("The local user object is closed.");
  }

  private releaseCapabilities() {
    this.pool?.[Symbol.dispose]();
    this.thread?.[Symbol.dispose]();
    this.pool = undefined;
    this.thread = undefined;
  }

  private async localSessionSecret() {
    const existing = await this.ctx.storage.get<string>(SESSION_SECRET_KEY);
    if (existing !== undefined) return existing;
    const bytes = await Effect.runPromise(
      Crypto.Crypto.use((crypto) => crypto.randomBytes(32)).pipe(
        Effect.provide(Platform.layerCrypto),
      ),
    );
    const secret = Hex.encode(bytes);
    await this.ctx.storage.put(SESSION_SECRET_KEY, secret);
    return secret;
  }
}
