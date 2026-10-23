import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import { ThreadId, type ModelSelection } from "@t3tools/contracts";
import { PERSONAL_POOL_ID } from "@t3tools/contracts/accountHub";
import type { AccountProfile } from "@t3tools/contracts/account";
import { DurableObject, RpcTarget, type RpcStub } from "cloudflare:workers";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import * as CloudAttachments from "../attachments/CloudAttachments.ts";
import { attachmentStorage } from "../attachments/attachmentObjects.ts";
import * as CloudTokens from "../auth/CloudTokens.ts";
import { HarnessError } from "../harness/Harness.ts";
import * as Platform from "../platform.ts";
import type { LocalPoolCapabilityApi } from "../pool/LocalPoolCapability.ts";
import { forwardLocalModelRequest } from "../pool/LocalModelRequest.ts";
import * as PoolDirectory from "../pool/PoolDirectory.ts";
import * as PoolEngine from "../pool/PoolEngine.ts";
import * as SearchSettings from "../search/searchSettings.ts";
import type { Actor } from "./ThreadAccess.ts";
import { ThreadObjectError } from "./ThreadAccess.ts";
import {
  type ProductClaudeThreadHostBinding,
  createProductClaudeThreadHost,
} from "./ProductClaudeThreadHost.ts";
import type { ProductClaudeThreadMachine } from "./ProductClaudeThreadHost.ts";
import type { LocalUserCapabilityApi } from "../user/LocalUserCapability.ts";
import { userThreadWire } from "../user/ThreadOperations.ts";
import * as ThreadUserServices from "./ThreadUserServices.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
import type { Threads } from "./Threads.ts";
import { wire } from "./threadWire.ts";
import type { ThreadCommandObjectApi } from "./ThreadCommandApi.ts";

const CONFIGURATION_KEY = "local-claude-thread-configuration-v1";
const SESSION_SECRET_KEY = "local-claude-thread-session-secret-v1";

export interface LocalClaudeThreadConfiguration {
  readonly threadId: string;
  readonly owner: AccountProfile;
  readonly modelSelection: ModelSelection;
}

type StoredConfiguration = {
  readonly threadId: string;
  readonly ownerId: string;
  readonly modelSelection: ModelSelection;
};

const configurationOf = (configuration: LocalClaudeThreadConfiguration): StoredConfiguration => ({
  threadId: configuration.threadId,
  ownerId: configuration.owner.id,
  modelSelection: configuration.modelSelection,
});

const configurationKey = (configuration: StoredConfiguration) => JSON.stringify(configuration);

const rejectedPoolReason = "This local pool only exposes its owner's Personal pool.";
const rejectPool = () =>
  Effect.fail(new PoolEngine.PoolRejectedError({ reason: rejectedPoolReason }));
const rejectedPoolHandle: PoolDirectory.PoolHandle = {
  create: () => rejectPool(),
  info: () => rejectPool(),
  rename: () => rejectPool(),
  setRouting: () => rejectPool(),
  setBacking: () => rejectPool(),
  delete: () => rejectPool(),
  accounts: () => rejectPool(),
  advice: () => rejectPool(),
  models: () => rejectPool(),
  startLogin: () => rejectPool(),
  loginStatus: () => rejectPool(),
  completeLogin: () => rejectPool(),
  cancelLogin: () => rejectPool(),
  logoutAccount: () => rejectPool(),
  updateAccount: () => rejectPool(),
  openLink: () => rejectPool(),
};

/** The nine canonical thread commands exposed to the owning user object. */
export interface LocalThreadCapabilityApi extends RpcTarget, ThreadCommandObjectApi {}

class LocalThreadCapability extends RpcTarget implements LocalThreadCapabilityApi {
  readonly #api: () => Promise<ThreadCommandObjectApi>;

  constructor(api: () => Promise<ThreadCommandObjectApi>) {
    super();
    this.#api = api;
  }

  async launch(...args: Parameters<ThreadCommandObjectApi["launch"]>) {
    return (await this.#api()).launch(...args);
  }
  async dispatch(...args: Parameters<ThreadCommandObjectApi["dispatch"]>) {
    return (await this.#api()).dispatch(...args);
  }
  async snapshot(...args: Parameters<ThreadCommandObjectApi["snapshot"]>) {
    return (await this.#api()).snapshot(...args);
  }
  async subscribe(...args: Parameters<ThreadCommandObjectApi["subscribe"]>) {
    return (await this.#api()).subscribe(...args);
  }
  async workspace(...args: Parameters<ThreadCommandObjectApi["workspace"]>) {
    return (await this.#api()).workspace(...args);
  }
  async commandOutput(...args: Parameters<ThreadCommandObjectApi["commandOutput"]>) {
    return (await this.#api()).commandOutput(...args);
  }
  async summary(...args: Parameters<ThreadCommandObjectApi["summary"]>) {
    return (await this.#api()).summary(...args);
  }
  async subscribePreparation(...args: Parameters<ThreadCommandObjectApi["subscribePreparation"]>) {
    return (await this.#api()).subscribePreparation(...args);
  }
  async cancelPreparation(...args: Parameters<ThreadCommandObjectApi["cancelPreparation"]>) {
    return (await this.#api()).cancelPreparation(...args);
  }
}

/** The client-side shape of a local thread object. `capability` resolves to an RPC stub. */
export interface LocalClaudeThreadObjectApi {
  readonly capability: () => Promise<RpcStub<LocalThreadCapabilityApi>>;
  readonly configure: (
    configuration: LocalClaudeThreadConfiguration,
    user: RpcStub<LocalUserCapabilityApi>,
    pool: RpcStub<LocalPoolCapabilityApi>,
  ) => Promise<void>;
  readonly failure: () => Promise<never>;
  readonly dispose: () => Promise<void>;
}

export type LocalClaudeThreadMachineFactory<Env, G, E> = (
  ctx: DurableObjectState,
  env: Env,
  configuration: LocalClaudeThreadConfiguration,
) => Effect.Effect<ProductClaudeThreadMachine<G>, E, Scope.Scope>;

/** Owns the thread's SQLite engine and Claude facet inside one Durable Object. */
export const createLocalClaudeThreadObject = <Env, G, E = HarnessError>(
  machine: LocalClaudeThreadMachineFactory<Env, G, E>,
) =>
  class LocalClaudeThreadObject extends DurableObject<Env> {
    private scope: Scope.Closeable | undefined;
    private binding: ProductClaudeThreadHostBinding<G> | undefined;
    private user: RpcStub<LocalUserCapabilityApi> | undefined;
    private pool: RpcStub<LocalPoolCapabilityApi> | undefined;
    private configuredAs: string | undefined;
    private closed = false;

    capability(): LocalThreadCapabilityApi {
      return new LocalThreadCapability(() => this.commandApi());
    }

    configure(
      configuration: LocalClaudeThreadConfiguration,
      user: RpcStub<LocalUserCapabilityApi>,
      pool: RpcStub<LocalPoolCapabilityApi>,
    ) {
      return this.ctx.blockConcurrencyWhile(async () => {
        if (this.closed) throw new Error("The local thread object is closed.");
        const identity = configurationOf(configuration);
        await this.assertConfiguration(identity);
        const key = configurationKey(identity);
        if (this.configuredAs !== undefined && this.configuredAs !== key)
          throw new Error("A local thread cannot be rebound to another owner, model, or thread.");
        if (this.binding !== undefined) return;

        const heldUser = user.dup();
        const heldPool = pool.dup();
        const scope = Effect.runSync(Scope.make());
        this.user = heldUser;
        this.pool = heldPool;
        this.scope = scope;
        this.configuredAs = key;
        try {
          this.binding = await Effect.runPromise(
            this.buildBinding(configuration, heldUser, heldPool).pipe(Scope.provide(scope)),
          );
        } catch (error) {
          this.binding = undefined;
          this.scope = undefined;
          this.releaseCapabilities();
          await Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => undefined);
          throw error;
        }
      });
    }

    async failure() {
      return Effect.runPromise((await this.getBinding()).failure);
    }

    async dispose() {
      if (this.closed) return;
      this.closed = true;
      const binding = this.binding;
      const scope = this.scope;
      this.binding = undefined;
      this.scope = undefined;
      try {
        if (binding !== undefined) await Effect.runPromise(binding.dispose);
      } finally {
        try {
          if (scope !== undefined) await Effect.runPromise(Scope.close(scope, Exit.void));
        } finally {
          this.releaseCapabilities();
        }
      }
    }

    private async assertConfiguration(identity: StoredConfiguration) {
      const key = configurationKey(identity);
      const stored = await this.ctx.storage.get<StoredConfiguration>(CONFIGURATION_KEY);
      if (stored !== undefined && configurationKey(stored) !== key)
        throw new Error("This thread storage belongs to another local owner, model, or thread.");
      if (stored === undefined) await this.ctx.storage.put(CONFIGURATION_KEY, identity);
      this.configuredAs = key;
    }

    protected async getBinding() {
      if (this.closed) throw new Error("The local thread object is closed.");
      if (this.binding === undefined) throw new Error("The local thread object is not configured.");
      return this.binding;
    }

    private async commandApi() {
      return (await this.getBinding()).api;
    }

    private releaseCapabilities() {
      this.user?.[Symbol.dispose]();
      this.pool?.[Symbol.dispose]();
      this.user = undefined;
      this.pool = undefined;
    }

    private buildBinding(
      configuration: LocalClaudeThreadConfiguration,
      user: RpcStub<LocalUserCapabilityApi>,
      pool: RpcStub<LocalPoolCapabilityApi>,
    ) {
      const ctx = this.ctx;
      const env = this.env;
      const sessionSecretEffect = Effect.promise(() => this.localSessionSecret());
      return Effect.gen(function* () {
        const currentActor: Effect.Effect<Actor, HarnessError> = Effect.tryPromise({
          try: () => user.getActor(),
          catch: (cause) =>
            new HarnessError({
              operation: "open",
              message: "Could not resolve the local thread owner.",
              cause,
            }),
        }).pipe(
          Effect.flatMap((actor) =>
            actor.userId === configuration.owner.id
              ? Effect.succeed(actor)
              : Effect.fail(
                  new HarnessError({
                    operation: "open",
                    message: "The local owner capability does not match the thread configuration.",
                  }),
                ),
          ),
        );
        yield* currentActor;

        const users = UserDirectory.local(configuration.owner.id, {
          profile: Effect.tryPromise(() => user.profile()),
          githubCommitAuthor: Effect.tryPromise(() => user.githubCommitAuthor()),
          onePasswordToken: Effect.tryPromise(() => user.onePasswordToken()),
          contextIds: Effect.tryPromise(() => user.contextIds()),
          driveAccess: (driveId) => Effect.tryPromise(() => user.driveAccess(driveId)),
          readableDrives: Effect.tryPromise(() => user.readableDrives()),
        });
        const userDirectory = Layer.succeed(UserDirectory.UserDirectory, users);
        const threadUsers = Layer.mergeAll(
          ThreadUserServices.layerDrives({ enabled: true }),
          ThreadUserServices.layerSecrets,
        ).pipe(Layer.provide(userDirectory));
        const personalPoolName = PoolDirectory.poolObjectName(
          configuration.owner.id,
          PERSONAL_POOL_ID,
        );
        const poolHandle = PoolDirectory.handleFor(pool);
        const poolDirectory = Layer.succeed(
          PoolDirectory.PoolDirectory,
          PoolDirectory.PoolDirectory.of({
            forPool: (name) => (name === personalPoolName ? poolHandle : rejectedPoolHandle),
          }),
        );
        const sessionSecret = yield* sessionSecretEffect;
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
        const platform = Layer.mergeAll(
          poolDirectory,
          threadUsers,
          attachments,
          Layer.succeed(SearchSettings.SearchSettings, { generation: "local", disabled: true }),
        );
        const implementation = yield* machine(ctx, env, configuration).pipe(
          Effect.mapError(
            (cause) =>
              new HarnessError({
                operation: "open",
                message: "Could not create the local thread machine.",
                cause,
              }),
          ),
        );
        const dispatchContinuation: Threads["Service"]["dispatch"] = (actor, command) =>
          Effect.tryPromise({
            try: () => user.dispatchContinuation(actor, userThreadWire.command.encode(command)),
            catch: (cause) => new ThreadObjectError({ operation: "continuation.dispatch", cause }),
          });
        const modelTransport = async (request: Request) => {
          const url = new URL(request.url);
          return forwardLocalModelRequest(request, (input) =>
            pool.requestModel(
              { userId: configuration.owner.id },
              `${url.pathname}${url.search}`,
              input,
              configuration.threadId,
            ),
          );
        };
        return yield* createProductClaudeThreadHost({
          threadId: ThreadId.make(configuration.threadId),
          sql: SqliteClient.layer({ storage: ctx.storage }),
          platform,
          actor: currentActor,
          host: { ...implementation.host, modelTransport },
          open: implementation.open,
          access: implementation.access,
          continuationDispatch: dispatchContinuation,
          recordSummary: (ownerId, summary) =>
            Effect.tryPromise({
              try: () => {
                if (ownerId !== configuration.owner.id)
                  throw new Error("The thread summary belongs to another owner.");
                return user.recordThreadSummary(wire.summary.encode(summary));
              },
              catch: (cause) =>
                new HarnessError({
                  operation: "events",
                  message: "Could not deliver the local thread summary.",
                  cause,
                }),
            }),
        });
      });
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
  };
