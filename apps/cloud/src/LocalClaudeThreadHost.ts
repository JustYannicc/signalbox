import {
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2SubscribeThreadInput,
  type OrchestrationV2ThreadLaunchInput,
  ThreadId,
} from "@t3tools/contracts";
import { PERSONAL_POOL_ID } from "@t3tools/contracts/accountHub";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as SqlClient from "effect/sql/SqlClient";

import * as CloudAttachments from "./attachments/CloudAttachments.ts";
import { attachmentStorage } from "./attachments/attachmentObjects.ts";
import * as CloudTokens from "./auth/CloudTokens.ts";
import { HarnessError } from "./harness/Harness.ts";
import { poolKindOfInstance } from "./models/ModelRouting.ts";
import * as Platform from "./platform.ts";
import { createLocalPool } from "./pool/LocalPool.ts";
import { PoolDirectory, poolObjectName } from "./pool/PoolDirectory.ts";
import { SearchSettings } from "./search/searchSettings.ts";
import {
  createProductClaudeThreadHost,
  type ProductClaudeThreadMachine,
} from "./thread/ProductClaudeThreadHost.ts";
import * as ThreadUserServices from "./thread/ThreadUserServices.ts";
import { onPool } from "./thread/turnPool.ts";
import { createLocalUser } from "./user/LocalUser.ts";

export interface LocalClaudeThreadMachine<G, SqlError, SqlRequirements> {
  readonly databases: Readonly<
    Record<"user" | "pool" | "thread", Layer.Layer<SqlClient.SqlClient, SqlError, SqlRequirements>>
  >;
  readonly host: Omit<ProductClaudeThreadMachine<G>["host"], "modelTransport">;
  readonly open: ProductClaudeThreadMachine<G>["open"];
  readonly access: ProductClaudeThreadMachine<G>["access"];
}

export interface LocalClaudeThreadHostOptions<G, SqlError, SqlRequirements> {
  readonly modelSelection: ModelSelection;
  readonly modelTransport: (request: Request) => Promise<Response>;
  readonly machine: LocalClaudeThreadMachine<G, SqlError, SqlRequirements>;
}

const failed = (message: string, cause?: unknown) =>
  new HarnessError({ operation: "open", message, ...(cause === undefined ? {} : { cause }) });

/** Provisions an owned local domain and runs its thread through the normal product queue. */
const makeLocalClaudeThreadHost = <G, SqlError, SqlRequirements>(
  options: LocalClaudeThreadHostOptions<G, SqlError, SqlRequirements>,
  scope: Scope.Closeable,
) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make(options.machine.host.threadId);
    if (poolKindOfInstance(options.modelSelection.instanceId) !== "claude")
      return yield* failed("The local Claude host needs a Claude model transport.");
    const poolReady =
      yield* Deferred.make<
        Effect.Success<ReturnType<typeof createLocalPool<SqlError, SqlRequirements>>>
      >();
    const user = yield* createLocalUser({
      sql: options.machine.databases.user,
      pools: (ownerId) =>
        createLocalPool({
          sql: options.machine.databases.pool,
          ownerId,
          transport: {
            id: "local",
            models: [{ id: options.modelSelection.model, ownedBy: "anthropic", created: null }],
            fetch: options.modelTransport,
          },
        }).pipe(
          Effect.tap((pool) => Deferred.succeed(poolReady, pool)),
          Effect.map((pool) => pool.directory),
        ),
    });
    const pool = yield* Deferred.await(poolReady);
    yield* pool.register;
    yield* user.refreshPools;
    const sessionSecret = Hex.encode(
      yield* Crypto.Crypto.use((crypto) => crypto.randomBytes(32)).pipe(
        Effect.orDie,
        Effect.provide(Platform.layerCrypto),
      ),
    );
    const tokens = CloudTokens.layerSessionSecret.pipe(
      Layer.provide(
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { SESSION_SECRET: sessionSecret } })),
      ),
    );
    const attachments = CloudAttachments.layer(attachmentStorage({})).pipe(
      Layer.provide(Layer.mergeAll(tokens, Platform.layerCrypto)),
    );
    const actor = user.actor.pipe(
      Effect.mapError((cause) => failed("The local domain could not resolve its owner.", cause)),
    );
    const binding = yield* createProductClaudeThreadHost({
      threadId,
      sql: options.machine.databases.thread,
      platform: Layer.mergeAll(
        user.platform,
        Layer.succeed(PoolDirectory, pool.directory),
        Layer.succeed(SearchSettings, { generation: "local", disabled: true }),
        attachments,
        ThreadUserServices.layerDrives({ enabled: true }).pipe(Layer.provide(user.platform)),
        ThreadUserServices.layerSecrets.pipe(Layer.provide(user.platform)),
      ),
      actor,
      host: { ...options.machine.host, modelTransport: pool.fetch },
      open: options.machine.open,
      access: options.machine.access,
    });
    yield* user.ready(binding.directory);
    return {
      owner: user.profile,
      actor,
      modelSelection: onPool(options.modelSelection, PERSONAL_POOL_ID),
      domain: user,
      pool: pool.directory.forPool(poolObjectName(user.profile.id, PERSONAL_POOL_ID)),
      threads: binding.threads,
      launch: (input: OrchestrationV2ThreadLaunchInput) =>
        Effect.flatMap(actor, (current) => binding.launch(current, input)),
      dispatch: (command: OrchestrationV2Command) =>
        Effect.flatMap(actor, (current) => binding.dispatch(current, command)),
      snapshot: () =>
        Effect.flatMap(actor, (current) => binding.threads.snapshot(current, threadId)),
      subscribe: (input: Omit<OrchestrationV2SubscribeThreadInput, "threadId"> = {}) =>
        Stream.unwrap(
          Effect.map(actor, (current) =>
            binding.threads.subscribe(current, {
              ...input,
              threadId,
            }),
          ),
        ),
      host: binding.host,
      failure: binding.failure,
      dispose: binding.dispose.pipe(Effect.ensuring(Scope.close(scope, Exit.void))),
    };
  });

export const createLocalClaudeThreadHost = <G, SqlError, SqlRequirements>(
  options: LocalClaudeThreadHostOptions<G, SqlError, SqlRequirements>,
) =>
  Effect.gen(function* () {
    const scope = yield* Scope.fork(yield* Scope.Scope);
    return yield* makeLocalClaudeThreadHost(options, scope).pipe(
      Scope.provide(scope),
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
  });
