import * as Layer from "effect/Layer";

import { readRpcData, withRpcStub } from "../../rpc/Resources.ts";
import { poolObjectStub, type PoolObjectNamespace } from "../../pool/PoolDirectory.ts";
import { threadObjectStub, type ThreadObjectNamespace } from "../../thread/ThreadDirectory.ts";
import { userObjectStub, type UserObjectNamespace } from "../../user/UserDirectory.ts";
import * as ModelAuthority from "../internal/ModelAuthority.ts";
import { relayRpcResponse } from "../internal/rpcResponse.ts";
import * as ModelAccess from "../ModelAccess.ts";
import type { LocalKeyVerifier } from "../ModelProtocol.ts";

export const layerModelAccess = (
  bindings: {
    readonly threads: ThreadObjectNamespace;
    readonly users: UserObjectNamespace;
    readonly pools: PoolObjectNamespace;
    readonly verifyLocalKey: LocalKeyVerifier;
  },
  options: { readonly localWorkerd: boolean },
) =>
  ModelAccess.layer.pipe(
    Layer.provide(
      Layer.succeed(
        ModelAuthority.ModelAuthority,
        ModelAuthority.ModelAuthority.of({
          authorizeThread: (threadId, token, provider) =>
            withRpcStub(threadObjectStub(bindings.threads, threadId, options), (stub) =>
              readRpcData(stub.authorizeModel(token, provider)),
            ),
          authorizeLocal: async (token) => {
            const key = await bindings.verifyLocalKey(token);
            return key === null
              ? { _tag: "denied", reason: "Not a Signalbox key." }
              : withRpcStub(userObjectStub(bindings.users, key.userId, options), (stub) =>
                  readRpcData(stub.authorizeLocalModel(key.secret)),
                );
          },
          forward: (pool, path, request, thread, trace) =>
            withRpcStub(poolObjectStub(bindings.pools, pool.objectName, options), async (stub) => {
              const reply = await stub.forwardModel(
                { userId: pool.userId },
                path,
                request,
                thread,
                trace,
              );
              if (reply._tag !== "forwarded") return readRpcData(Promise.resolve(reply));
              return {
                ...reply,
                response: relayRpcResponse(reply.response, reply),
              };
            }),
          recordThread: (threadId, record) =>
            withRpcStub(threadObjectStub(bindings.threads, threadId, options), (stub) =>
              stub.recordModelRequest(record),
            ),
          recordLocal: (local, usage) =>
            withRpcStub(userObjectStub(bindings.users, local.userId, options), (stub) =>
              stub.recordLocalModelRequest({
                keyId: local.keyId,
                usage,
              }),
            ),
        }),
      ),
    ),
  );
