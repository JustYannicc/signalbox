// @effect-diagnostics globalDate:off globalConsole:off - a plain Workers fetch handler that forwards streams; no Effect runtime on the hot path.
import type { ModelGatewayProvider } from "@signalbox/runner-protocol/RunnerProtocol";

import type { ModelServeReply } from "../thread/runner/modelGrants.ts";
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
    /** Hands a request's record to the thread its token names, for the turn's diagnostics. */
    readonly report: (record: ModelGatewayRecord) => Promise<void>;
  };
}

export default {
  fetch(request, env, ctx) {
    return handleModelRequest(request, {
      serve: (token, provider, path, forwarded) =>
        env.GRANTS.serve(token, provider, path, forwarded),
      now: () => Date.now(),
      log: (record) => {
        console.log(JSON.stringify({ event: "model_gateway.request", ...record }));
        // In the background, so a slow thread never holds the response up. Only a
        // granted request is for a turn; a denied one names whatever thread its token claims.
        if (record.threadId !== null && record.runId !== null) {
          ctx.waitUntil(env.GRANTS.report(record).catch(() => undefined));
        }
      },
    });
  },
} satisfies ExportedHandler<ModelGatewayEnv>;
