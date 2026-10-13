import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { LoginStart, LoginStatus, PoolLoginProvider } from "./cliProxyApi.ts";
import {
  type AccountAction,
  type PoolAccounts,
  type PoolBackingInput,
  type PoolActor,
  type PoolInfo,
  PoolRejectedError,
} from "./PoolEngine.ts";

/**
 * How user objects reach pool objects. Every pool has exactly one, named by
 * `poolObjectName` and always created in the EU jurisdiction. Calls are
 * Durable Object RPC; refusals come back as values so their message reaches
 * the user, and anything else is a `PoolObjectError`.
 */

export const POOL_OBJECT_JURISDICTION = "eu";

/** A pool's object name: its owner and the pool's id, which is unique per owner. */
export const poolObjectName = (ownerUserId: string, poolId: string) => `${ownerUserId}:${poolId}`;

export class PoolObjectError extends Schema.TaggedError<PoolObjectError>()("PoolObjectError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Pool object call failed (${this.operation}).`;
  }
}

export type PoolReply<A> =
  | { readonly _tag: "ok"; readonly value: A }
  | { readonly _tag: "rejected"; readonly reason: string };

/** What a pool object answers. `PoolObject` implements it method for method. */
export interface PoolObjectApi {
  readonly create: (
    actor: PoolActor,
    input: { readonly name: string; readonly personal: boolean },
  ) => Promise<PoolReply<PoolInfo>>;
  readonly info: (actor: PoolActor) => Promise<PoolReply<PoolInfo>>;
  readonly rename: (actor: PoolActor, name: string) => Promise<PoolReply<PoolInfo>>;
  readonly setBacking: (
    actor: PoolActor,
    backing: PoolBackingInput,
  ) => Promise<PoolReply<PoolInfo>>;
  /** Stops the pool's container and erases the pool. */
  readonly delete: (actor: PoolActor) => Promise<PoolReply<null>>;
  readonly accounts: (actor: PoolActor) => Promise<PoolReply<PoolAccounts>>;
  readonly startLogin: (
    actor: PoolActor,
    provider: PoolLoginProvider,
  ) => Promise<PoolReply<LoginStart>>;
  readonly loginStatus: (actor: PoolActor, state: string) => Promise<PoolReply<LoginStatus>>;
  readonly completeLogin: (actor: PoolActor, redirectUrl: string) => Promise<PoolReply<null>>;
  readonly cancelLogin: (actor: PoolActor, state: string) => Promise<PoolReply<null>>;
  readonly updateAccount: (
    actor: PoolActor,
    name: string,
    action: AccountAction,
  ) => Promise<PoolReply<null>>;
}

type Method = keyof PoolObjectApi;

export type PoolHandle = {
  readonly [K in Method]: (
    ...args: Parameters<PoolObjectApi[K]>
  ) => Effect.Effect<
    Awaited<ReturnType<PoolObjectApi[K]>> extends PoolReply<infer A> ? A : never,
    PoolRejectedError | PoolObjectError
  >;
};

export class PoolDirectory extends Context.Service<
  PoolDirectory,
  { readonly forPool: (objectName: string) => PoolHandle }
>()("@signalbox/cloud/pool/PoolDirectory") {}

// A record, so adding a method to `PoolObjectApi` without wrapping it fails to compile.
const METHODS = Object.keys({
  create: true,
  info: true,
  rename: true,
  setBacking: true,
  delete: true,
  accounts: true,
  startLogin: true,
  loginStatus: true,
  completeLogin: true,
  cancelLogin: true,
  updateAccount: true,
} satisfies Record<Method, true>) as ReadonlyArray<Method>;

/** What to tell the user when a pool call fails: the pool's own refusal, or a logged outage. */
export const poolErrorMessage = (error: PoolRejectedError | PoolObjectError) =>
  error._tag === "PoolRejectedError"
    ? Effect.succeed(error.reason)
    : Effect.logError("pool object call failed", { cause: error }).pipe(
        Effect.as("The pool is unavailable right now. Try again."),
      );

/** Wraps any `PoolObjectApi` (a Durable Object stub, or a test double) as Effects. */
export function handleFor(api: PoolObjectApi): PoolHandle {
  const call =
    (operation: Method) =>
    (...args: ReadonlyArray<unknown>) =>
      Effect.tryPromise({
        try: () =>
          (api[operation] as (...input: ReadonlyArray<unknown>) => Promise<PoolReply<unknown>>)(
            ...args,
          ),
        catch: (cause) => new PoolObjectError({ operation, cause }),
      }).pipe(
        Effect.flatMap((reply) =>
          reply._tag === "ok"
            ? Effect.succeed(reply.value)
            : Effect.fail(new PoolRejectedError({ reason: reply.reason })),
        ),
      );
  return Object.fromEntries(METHODS.map((method) => [method, call(method)])) as PoolHandle;
}

/** The slice of the `POOLS` Durable Object namespace binding callers use. */
export interface PoolObjectNamespace {
  readonly idFromName: (name: string) => DurableObjectId;
  readonly idFromString: (id: string) => DurableObjectId;
  readonly jurisdiction: (name: typeof POOL_OBJECT_JURISDICTION) => {
    readonly idFromName: (name: string) => DurableObjectId;
  };
  readonly get: (id: DurableObjectId) => PoolObjectApi & Fetcher;
}

/** Local workerd has no jurisdictions, so `wrangler dev` uses the plain namespace. */
export const poolObjectStub = (
  namespace: PoolObjectNamespace,
  objectName: string,
  options: { readonly localWorkerd: boolean },
) => {
  const ids = options.localWorkerd ? namespace : namespace.jurisdiction(POOL_OBJECT_JURISDICTION);
  return namespace.get(ids.idFromName(objectName));
};

export const layerDurableObjects = (
  namespace: PoolObjectNamespace,
  options: { readonly localWorkerd: boolean },
) =>
  Layer.succeed(
    PoolDirectory,
    PoolDirectory.of({
      forPool: (objectName) => handleFor(poolObjectStub(namespace, objectName, options)),
    }),
  );
