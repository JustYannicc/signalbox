import * as Layer from "effect/Layer";

import { poolObjectStub, type PoolObjectNamespace } from "../../pool/PoolDirectory.ts";
import { threadObjectStub, type ThreadObjectNamespace } from "../../thread/ThreadDirectory.ts";
import { userObjectStub, type UserObjectNamespace } from "../../user/UserDirectory.ts";
import * as ModelAuthority from "../internal/ModelAuthority.ts";
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
            threadObjectStub(bindings.threads, threadId, options).authorizeModel(token, provider),
          authorizeLocal: async (token) => {
            const key = await bindings.verifyLocalKey(token);
            return key === null
              ? { _tag: "denied", reason: "Not a Signalbox key." }
              : userObjectStub(bindings.users, key.userId, options).authorizeLocalModel(key.secret);
          },
          forward: (pool, path, request, thread) =>
            poolObjectStub(bindings.pools, pool.objectName, options).forwardModel(
              { userId: pool.userId },
              path,
              request,
              thread,
            ),
          recordThread: (threadId, record) =>
            threadObjectStub(bindings.threads, threadId, options).recordModelRequest(record),
          recordLocal: (local, usage) =>
            userObjectStub(bindings.users, local.userId, options).recordLocalModelRequest({
              keyId: local.keyId,
              usage,
            }),
        }),
      ),
    ),
  );
