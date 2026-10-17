// @effect-diagnostics globalDate:off - a plain Workers fetch handler that forwards streams; no Effect runtime on the hot path.
import type { ModelGatewayProvider } from "@signalbox/runner-protocol/RunnerProtocol";
import { defineWorkerFetch } from "evlog/workers";

import * as Evlog from "../observability/evlogWorkers.ts";
import type { ModelServeReply } from "../models/ModelProtocol.ts";
import { handleModelRequest } from "./modelGateway.ts";
import type { ModelGatewayRecord } from "./modelGatewayRecord.ts";

/**
 * The ModelGateway Worker (`wrangler.model-gateway.jsonc`): the public origin
 * machines' harnesses call. It holds no keys, and never learns which pool a
 * turn runs on: the cloud's `ModelGrants` entrypoint, over a service binding,
 * checks each token and sends granted requests to the turn's pool. Each
 * record goes to its thread the same way. See `modelGateway.ts`.
 */

export interface ModelGatewayEnv {
  readonly GRANTS: {
    readonly serve: (
      token: string,
      provider: ModelGatewayProvider,
      path: string,
      request: Request,
    ) => Promise<ModelServeReply>;
    /** Hands a request's record to the thread its token names, or a local key's to its user. */
    readonly report: (record: ModelGatewayRecord) => Promise<void>;
  };
}

Evlog.init();

/** A request's record on its wide event: the pool call, in the shared dimensions. */
const fieldsOf = (record: ModelGatewayRecord) =>
  ({
    route: "model",
    provider: record.provider,
    ...(record.model !== null && { model: record.model }),
    ...(record.threadId !== null && { thread: { id: record.threadId } }),
    ...(record.runId !== null && {
      turn: { id: record.runId, ...(record.traceId !== null && { traceId: record.traceId }) },
    }),
    ...(record.local !== undefined && { person: { id: record.local.userId } }),
  }) satisfies Evlog.CloudFields;

// One wide event per model request. It owns its emit: a forwarded body is
// recorded when it ends, which can be after the response is returned.
export default defineWorkerFetch<ModelGatewayEnv>(async (request, env, ctx, log) => {
  // Once the token is checked, every request ends in exactly one record.
  let checked = false;
  const response = await handleModelRequest(request, {
    serve: (token, provider, path, forwarded) => {
      checked = true;
      return env.GRANTS.serve(token, provider, path, forwarded);
    },
    now: () => Date.now(),
    log: (record) => {
      // The ids are the shared dimensions in `fieldsOf`; the rest is the request.
      const {
        local: _local,
        threadId: _thread,
        runId: _run,
        traceId: _trace,
        provider: _provider,
        model: _model,
        ...rest
      } = record;
      log.set({ ...fieldsOf(record), modelGateway: rest });
      log.emit({ status: record.status });
      ctx.waitUntil(Evlog.drainsSettled());
      // In the background, so a slow thread never holds the response up. Only a
      // granted request is for a turn; a denied one names whatever thread its token claims.
      // A key counts what its pool served.
      const served = record.local !== undefined && record.status < 400;
      if ((record.threadId !== null && record.runId !== null) || served) {
        ctx.waitUntil(env.GRANTS.report(record).catch(() => undefined));
      }
    },
  });
  // Turned away before the token was checked: a wrong path or no token.
  if (!checked) {
    log.emit({ status: response.status, route: "model" });
    ctx.waitUntil(Evlog.drainsSettled());
  }
  return response;
}) satisfies ExportedHandler<ModelGatewayEnv>;
