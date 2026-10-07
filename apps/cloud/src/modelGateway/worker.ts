// @effect-diagnostics globalFetch:off globalDate:off globalConsole:off - a plain Workers fetch handler that forwards streams; no Effect runtime on the hot path.
import type { ModelGatewayProvider } from "@signalbox/runner-protocol/RunnerProtocol";

import type { ModelAuthorization } from "../thread/runner/ThreadRunner.ts";
import { handleModelRequest, type Upstream } from "./modelGateway.ts";

/**
 * The ModelGateway Worker (`wrangler.model-gateway.jsonc`): its own Worker so
 * provider keys are bound here and nowhere else, not even in the cloud Worker.
 * It asks the cloud about each token through a service binding to the cloud's
 * `ModelGrants` entrypoint. See `modelGateway.ts`.
 */

export interface ModelGatewayEnv {
  readonly GRANTS: {
    readonly authorize: (
      token: string,
      provider: ModelGatewayProvider,
    ) => Promise<ModelAuthorization>;
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
  fetch(request, env) {
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
      log: (record) => console.log(JSON.stringify({ event: "model_gateway.request", ...record })),
    });
  },
} satisfies ExportedHandler<ModelGatewayEnv>;
