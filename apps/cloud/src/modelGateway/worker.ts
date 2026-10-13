// @effect-diagnostics globalFetch:off globalDate:off globalConsole:off - a plain Workers fetch handler that forwards streams; no Effect runtime on the hot path.
import type { ModelGatewayProvider } from "@signalbox/runner-protocol/RunnerProtocol";

import type { ModelAuthorization } from "../thread/runner/ThreadRunner.ts";
import { handleModelRequest, type Upstream } from "./modelGateway.ts";
import type { ModelGatewayRecord } from "./modelGatewayRecord.ts";

/**
 * The ModelGateway Worker (`wrangler.model-gateway.jsonc`): its own Worker so
 * provider keys are bound here and nowhere else, not even in the cloud Worker.
 * It asks the cloud about each token through a service binding to the cloud's
 * `ModelGrants` entrypoint, and reports each record to its thread the same
 * way. See `modelGateway.ts`.
 */

export interface ModelGatewayEnv {
  readonly GRANTS: {
    readonly authorize: (
      token: string,
      provider: ModelGatewayProvider,
    ) => Promise<ModelAuthorization>;
    /** Hands a request's record to the thread its token names, for the turn's diagnostics. */
    readonly report: (record: ModelGatewayRecord) => Promise<void>;
  };
  readonly ANTHROPIC_API_KEY?: string;
  readonly OPENAI_API_KEY?: string;
  /** Override the provider's API origin, e.g. to point at a compatible proxy. */
  readonly ANTHROPIC_UPSTREAM_URL?: string;
  readonly OPENAI_UPSTREAM_URL?: string;
}

const upstream = (apiKey: string | undefined, baseUrl: string | undefined, fallback: string) =>
  apiKey === undefined || apiKey === ""
    ? null
    : ({
        apiKey,
        baseUrl: baseUrl === undefined || baseUrl === "" ? fallback : baseUrl,
      } satisfies Upstream);

export default {
  fetch(request, env, ctx) {
    return handleModelRequest(request, {
      authorize: (token, provider) => env.GRANTS.authorize(token, provider),
      upstreams: {
        anthropic: upstream(
          env.ANTHROPIC_API_KEY,
          env.ANTHROPIC_UPSTREAM_URL,
          "https://api.anthropic.com",
        ),
        openai: upstream(env.OPENAI_API_KEY, env.OPENAI_UPSTREAM_URL, "https://api.openai.com"),
      },
      fetch: (forwarded) => fetch(forwarded),
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
