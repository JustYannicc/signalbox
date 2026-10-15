// @effect-diagnostics globalDate:off - promise code behind a service binding; times the token check for the gateway's record.
import {
  MODEL_GATEWAY_PATHS,
  type ModelGatewayProvider,
} from "@signalbox/runner-protocol/RunnerProtocol";
import { type RunId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { isLocalKey } from "../../localKeys/LocalKeys.ts";
import type { ModelGatewayRecord } from "../../modelGateway/modelGatewayRecord.ts";
import {
  type ModelForwardReply,
  type ModelPoolRoute,
  type PoolObjectNamespace,
  poolObjectStub,
} from "../../pool/PoolDirectory.ts";
import { type UserObjectNamespace, userObjectStub } from "../../user/UserDirectory.ts";
import { type ThreadObjectNamespace, threadObjectStub } from "../ThreadDirectory.ts";
import { threadOfModelToken } from "./modelToken.ts";
import type { ModelAuthorization } from "./ThreadRunner.ts";

/**
 * The cloud's side of a ModelGateway request, in one call: the token names its
 * thread, and that thread's object decides, naming the pool the turn runs on.
 * The request then goes to that pool's object, which checks the requester
 * still has the pool and sends it to the pool's CLIProxyAPI. The gateway never
 * learns which pool, and reports what the request did to the thread. Reached
 * only through the gateway's service binding (`ModelGrants` in `worker.ts`),
 * never from the internet.
 *
 * A local key (`localKeys/LocalKeys.ts`) takes the same path with the user's
 * object in the thread's place: it names the pool the user's top level runs
 * on, and the pool checks the user as it checks a turn's requester.
 */

/**
 * How the cloud answered a model request. `authMs`: checking the token with its
 * thread, or a local key with its user.
 */
export type ModelServeReply =
  | { readonly _tag: "denied"; readonly reason: string; readonly authMs: number }
  | {
      readonly _tag: "granted";
      readonly runId: RunId;
      readonly traceId: string;
      readonly authMs: number;
      readonly reply: ModelForwardReply;
    }
  | {
      readonly _tag: "granted-local";
      readonly userId: string;
      readonly keyId: string;
      readonly authMs: number;
      readonly reply: ModelForwardReply;
    };

/** Checks a local key's signature, without waking anything (`verifyLocalKey`). */
export type LocalKeyVerifier = (
  token: string,
) => Promise<{ readonly userId: string; readonly secret: string } | null>;

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

export function authorizeModel(
  threads: ThreadObjectNamespace,
  token: string,
  provider: ModelGatewayProvider,
  options: { readonly localWorkerd: boolean },
): Promise<ModelAuthorization> {
  const name = threadOfModelToken(token);
  const threadId = name === null ? null : decodeThreadId(name);
  if (
    threadId === null ||
    threadId._tag === "None" ||
    !Object.hasOwn(MODEL_GATEWAY_PATHS, provider)
  ) {
    return Promise.resolve({ _tag: "denied", reason: "Not a model token." });
  }
  return threadObjectStub(threads, threadId.value, options).authorizeModel(token, provider);
}

/**
 * Hands a served request's record to its thread, or a local key's to its user.
 * A record naming no valid thread is dropped.
 */
export function reportModelRequest(
  targets: { readonly threads: ThreadObjectNamespace; readonly users: UserObjectNamespace },
  record: ModelGatewayRecord,
  options: { readonly localWorkerd: boolean },
): Promise<void> {
  const { threads } = targets;
  if (record.local !== undefined) {
    return userObjectStub(targets.users, record.local.userId, options).recordLocalModelRequest({
      keyId: record.local.keyId,
      usage: record.usage,
    });
  }
  const threadId = record.threadId === null ? null : decodeThreadId(record.threadId);
  if (threadId === null || threadId._tag === "None") return Promise.resolve();
  return threadObjectStub(threads, threadId.value, options).recordModelRequest(record);
}

/**
 * Checks `token` and, granted, sends the request to the turn's pool. Throws
 * only when the token could not be checked. `path` includes the query.
 */
export async function serveModel(
  input: {
    readonly threads: ThreadObjectNamespace;
    readonly users: UserObjectNamespace;
    readonly pools: PoolObjectNamespace;
    readonly verifyLocalKey: LocalKeyVerifier;
    readonly token: string;
    readonly provider: ModelGatewayProvider;
    readonly path: string;
    readonly request: Request;
  },
  options: { readonly localWorkerd: boolean },
): Promise<ModelServeReply> {
  if (isLocalKey(input.token)) return serveLocalModel(input, options);
  const startedAt = Date.now();
  const authorization = await authorizeModel(input.threads, input.token, input.provider, options);
  const authMs = Date.now() - startedAt;
  if (authorization._tag === "denied") return { ...authorization, authMs };
  const { runId, traceId, pool } = authorization;
  const reply = await forwardToPool(input, pool, options);
  return { _tag: "granted", runId, traceId, authMs, reply };
}

async function serveLocalModel(
  input: Parameters<typeof serveModel>[0],
  options: { readonly localWorkerd: boolean },
): Promise<ModelServeReply> {
  const startedAt = Date.now();
  const key = await input.verifyLocalKey(input.token);
  const authorization =
    key === null
      ? ({ _tag: "denied", reason: "Not a Signalbox key." } as const)
      : await userObjectStub(input.users, key.userId, options).authorizeLocalModel(key.secret);
  const authMs = Date.now() - startedAt;
  if (authorization._tag === "denied") return { ...authorization, authMs };
  const { keyId, pool } = authorization;
  const reply = await forwardToPool(input, pool, options);
  return { _tag: "granted-local", userId: pool.userId, keyId, authMs, reply };
}

/** Sends a granted request to its pool's object, which checks the user may still use the pool. */
const forwardToPool = (
  input: Parameters<typeof serveModel>[0],
  pool: ModelPoolRoute,
  options: { readonly localWorkerd: boolean },
) =>
  poolObjectStub(input.pools, pool.objectName, options)
    .forwardModel({ userId: pool.userId }, input.path, input.request)
    .catch((): ModelForwardReply => ({ _tag: "failed", reason: "The pool could not be reached." }));
