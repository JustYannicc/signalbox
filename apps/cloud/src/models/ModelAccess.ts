import { MODEL_GATEWAY_PATHS } from "@signalbox/runner-protocol/RunnerProtocol";
import { ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { isLocalKey } from "../localKeys/LocalKeys.ts";
import type { ModelGatewayRecord } from "../modelGateway/modelGatewayRecord.ts";
import { scrubModelRequest } from "../modelGateway/scrubModelRequest.ts";
import { threadOfModelToken } from "../thread/ModelTokens.ts";
import * as ModelAuthority from "./internal/ModelAuthority.ts";
import type {
  ModelForwardReply,
  ModelPoolRoute,
  ModelRequest,
  ModelServeReply,
} from "./ModelProtocol.ts";

/** Promise methods match the gateway binding without a per-request Effect runtime. */
export class ModelAccess extends Context.Service<
  ModelAccess,
  {
    /** Reauthorizes each request. Authority outages reject; pool outages return a failed reply. */
    readonly serve: (input: ModelRequest) => Promise<ModelServeReply>;
    readonly report: (record: ModelGatewayRecord) => Promise<void>;
  }
>()("@signalbox/cloud/models/ModelAccess") {}

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

const make = Effect.gen(function* () {
  const authority = yield* ModelAuthority.ModelAuthority;
  const clock = yield* Clock.Clock;
  const now = () => clock.currentTimeMillisUnsafe();

  const forward = async (input: ModelRequest, pool: ModelPoolRoute, thread?: string) => {
    try {
      return await authority.forward(pool, input.path, input.request, thread);
    } catch {
      return {
        _tag: "failed",
        reason: "The pool could not be reached.",
      } satisfies ModelForwardReply;
    }
  };

  const serve: ModelAccess["Service"]["serve"] = async (input) => {
    const startedAt = now();
    if (isLocalKey(input.token)) {
      const authorization = await authority.authorizeLocal(input.token);
      const authMs = now() - startedAt;
      if (authorization._tag === "denied") return { ...authorization, authMs };
      const { keyId, pool } = authorization;
      const reply = await forward(input, pool);
      return { _tag: "granted-local", userId: pool.userId, keyId, authMs, reply };
    }

    const name = threadOfModelToken(input.token);
    const threadId = name === null ? null : decodeThreadId(name);
    if (
      threadId === null ||
      threadId._tag === "None" ||
      !Object.hasOwn(MODEL_GATEWAY_PATHS, input.provider)
    ) {
      return { _tag: "denied", reason: "Not a model token.", authMs: now() - startedAt };
    }
    const authorization = await authority.authorizeThread(
      threadId.value,
      input.token,
      input.provider,
    );
    const authMs = now() - startedAt;
    if (authorization._tag === "denied") return { ...authorization, authMs };
    if (authorization._tag === "unregistered") {
      const { runId, traceId, reason } = authorization;
      return { _tag: "granted", runId, traceId, authMs, reply: { _tag: "denied", reason } };
    }

    const { runId, traceId, pool } = authorization;
    const scrubbed = scrubModelRequest(input.request, authorization.secrets);
    if (scrubbed._tag === "refused") {
      return {
        _tag: "granted",
        runId,
        traceId,
        authMs,
        reply: { _tag: "denied", reason: scrubbed.reason },
      };
    }
    // The pool uses the thread identity to keep its requests on the same account.
    const reply = await forward({ ...input, request: scrubbed.request }, pool, name ?? undefined);
    return { _tag: "granted", runId, traceId, authMs, reply };
  };

  const report: ModelAccess["Service"]["report"] = (record) => {
    if (record.local !== undefined) return authority.recordLocal(record.local, record.usage);
    const threadId = record.threadId === null ? null : decodeThreadId(record.threadId);
    return threadId === null || threadId._tag === "None"
      ? Promise.resolve()
      : authority.recordThread(threadId.value, record);
  };

  return ModelAccess.of({ serve, report });
});

export const layer = Layer.effect(ModelAccess, make);
