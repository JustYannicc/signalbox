// @effect-diagnostics globalDate:off - promise code behind a service binding; times the token check for the gateway's record.
import {
  MODEL_GATEWAY_PATHS,
  type ModelGatewayProvider,
} from "@signalbox/runner-protocol/RunnerProtocol";
import { type RunId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { ModelGatewayRecord } from "../../modelGateway/modelGatewayRecord.ts";
import {
  type ModelForwardReply,
  type PoolObjectNamespace,
  poolObjectStub,
} from "../../pool/PoolDirectory.ts";
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
 */

/** How the cloud answered a model request. `authMs`: checking the token with its thread. */
export type ModelServeReply =
  | { readonly _tag: "denied"; readonly reason: string; readonly authMs: number }
  | {
      readonly _tag: "granted";
      readonly runId: RunId;
      readonly traceId: string;
      readonly authMs: number;
      readonly reply: ModelForwardReply;
    };

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

/** Hands a served request's record to its thread. A record naming no valid thread is dropped. */
export function reportModelRequest(
  threads: ThreadObjectNamespace,
  record: ModelGatewayRecord,
  options: { readonly localWorkerd: boolean },
): Promise<void> {
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
    readonly pools: PoolObjectNamespace;
    readonly token: string;
    readonly provider: ModelGatewayProvider;
    readonly path: string;
    readonly request: Request;
  },
  options: { readonly localWorkerd: boolean },
): Promise<ModelServeReply> {
  const startedAt = Date.now();
  const authorization = await authorizeModel(input.threads, input.token, input.provider, options);
  const authMs = Date.now() - startedAt;
  if (authorization._tag === "denied") return { ...authorization, authMs };
  const { runId, traceId, pool } = authorization;
  const reply = await poolObjectStub(input.pools, pool.objectName, options)
    .forwardModel({ userId: pool.userId }, input.path, input.request)
    .catch((): ModelForwardReply => ({ _tag: "failed", reason: "The pool could not be reached." }));
  return { _tag: "granted", runId, traceId, authMs, reply };
}
