import {
  MODEL_GATEWAY_PATHS,
  type ModelGatewayProvider,
} from "@signalbox/runner-protocol/RunnerProtocol";

import { threadOfModelToken } from "../thread/runner/modelToken.ts";
import type { ModelAuthorization } from "../thread/runner/ThreadRunner.ts";

/**
 * The ModelGateway: the only place provider keys live. Harnesses on a machine
 * call it as their provider's API (Claude Code through `ANTHROPIC_BASE_URL`,
 * Codex through a custom provider's `base_url`) with a model token instead of
 * a key. Each request is checked with the token's thread, which grants it only
 * while the turn the token was minted for is running, then forwarded with the
 * real key. The upstream response streams back as it arrives.
 *
 * Only the endpoints a harness needs for a turn are served, so a token is no
 * use for anything else the key could do.
 */

export interface Upstream {
  /** e.g. `https://api.anthropic.com`; request paths start at `/v1`. */
  readonly baseUrl: string;
  readonly apiKey: string;
}

/** One served request, logged when its response ends. The gateway adds `authMs` before forwarding. */
export interface ModelGatewayRecord {
  readonly provider: ModelGatewayProvider;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly threadId: string | null;
  readonly runId: string | null;
  /** Why the thread turned the token down. */
  readonly denied?: string;
  /** Checking the token with its thread. */
  readonly authMs: number;
  /** From forwarding to the upstream's response headers. */
  readonly upstreamHeadersMs: number | null;
  /** From forwarding to the first body chunk: the upstream's time to first token. */
  readonly firstChunkMs: number | null;
  readonly totalMs: number;
  /** How a forwarded response's body ended: read to the end, dropped by the caller, or broken. */
  readonly outcome?: "complete" | "cancelled" | "failed";
}

export interface ModelGatewayDeps {
  readonly authorize: (
    token: string,
    provider: ModelGatewayProvider,
  ) => Promise<ModelAuthorization>;
  readonly upstreams: Readonly<Record<ModelGatewayProvider, Upstream | null>>;
  readonly fetch: (request: Request) => Promise<Response>;
  readonly now: () => number;
  readonly log: (record: ModelGatewayRecord) => void;
}

const SERVED_PATHS: Readonly<Record<ModelGatewayProvider, ReadonlyArray<string>>> = {
  anthropic: ["/v1/messages", "/v1/models"],
  openai: ["/v1/responses", "/v1/models"],
};

const PROVIDERS = Object.keys(MODEL_GATEWAY_PATHS) as ReadonlyArray<ModelGatewayProvider>;

/** Headers that carry the caller's credential, or describe the hop rather than the request. */
const DROPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "host",
  "cookie",
  "content-length",
]);
/** The runtime decodes the upstream body, so its encoding and length no longer apply. */
const DROPPED_RESPONSE_HEADERS = ["content-encoding", "content-length", "transfer-encoding"];

/** An error in the shape the provider's own API uses, so the harness shows the message. */
function errorResponse(provider: ModelGatewayProvider | null, status: number, message: string) {
  const body =
    provider === "openai"
      ? {
          error: {
            message,
            type: "invalid_request_error",
            code: status === 401 ? "invalid_api_key" : null,
          },
        }
      : {
          type: "error",
          error: { type: status === 401 ? "authentication_error" : "api_error", message },
        };
  return Response.json(body, { status });
}

function bearerOrKey(headers: Headers): string | null {
  const key = headers.get("x-api-key");
  if (key !== null && key !== "") return key;
  const authorization = headers.get("authorization");
  const match = authorization === null ? null : /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1] ?? null;
}

function withUpstreamKey(provider: ModelGatewayProvider, source: Headers, apiKey: string) {
  const headers = new Headers();
  for (const [name, value] of source) {
    const dropped =
      DROPPED_REQUEST_HEADERS.has(name) ||
      name.startsWith("cf-") ||
      name.startsWith("x-forwarded-");
    if (!dropped) headers.append(name, value);
  }
  if (provider === "anthropic") headers.set("x-api-key", apiKey);
  else headers.set("authorization", `Bearer ${apiKey}`);
  return headers;
}

export async function handleModelRequest(
  request: Request,
  deps: ModelGatewayDeps,
): Promise<Response> {
  const url = new URL(request.url);
  const provider =
    PROVIDERS.find((candidate) => url.pathname.startsWith(`${MODEL_GATEWAY_PATHS[candidate]}/`)) ??
    null;
  if (provider === null) return errorResponse(null, 404, "Not a ModelGateway path.");
  const path = url.pathname.slice(MODEL_GATEWAY_PATHS[provider].length);
  if (!SERVED_PATHS[provider].some((served) => path === served || path.startsWith(`${served}/`))) {
    return errorResponse(provider, 404, `The ModelGateway does not serve ${path}.`);
  }
  const token = bearerOrKey(request.headers);
  if (token === null) return errorResponse(provider, 401, "Missing model token.");
  const upstream = deps.upstreams[provider];
  if (upstream === null) {
    return errorResponse(provider, 503, `The ModelGateway has no ${provider} key.`);
  }

  const startedAt = deps.now();
  const threadId = threadOfModelToken(token);
  const record = (fields: Partial<ModelGatewayRecord> & Pick<ModelGatewayRecord, "status">) =>
    deps.log({
      provider,
      method: request.method,
      path,
      threadId,
      runId: null,
      authMs: 0,
      upstreamHeadersMs: null,
      firstChunkMs: null,
      totalMs: deps.now() - startedAt,
      ...fields,
    });

  let authorization: ModelAuthorization;
  try {
    authorization = await deps.authorize(token, provider);
  } catch {
    record({ status: 503, authMs: deps.now() - startedAt });
    return errorResponse(provider, 503, "Could not check the model token. Try again.");
  }
  const authMs = deps.now() - startedAt;
  if (authorization._tag === "denied") {
    record({ status: 401, authMs, denied: authorization.reason });
    return errorResponse(provider, 401, authorization.reason);
  }
  const runId = authorization.runId;

  const forwarded: RequestInit & { readonly duplex: "half" } = {
    method: request.method,
    headers: withUpstreamKey(provider, request.headers, upstream.apiKey),
    body: request.body,
    redirect: "manual",
    // The request body streams through rather than being buffered (Node requires saying so).
    duplex: "half",
  };
  const forwardedAt = deps.now();
  let response: Response;
  try {
    response = await deps.fetch(
      new Request(`${upstream.baseUrl.replace(/\/+$/, "")}${path}${url.search}`, forwarded),
    );
  } catch {
    record({ status: 502, runId, authMs, outcome: "failed" });
    return errorResponse(provider, 502, `Could not reach ${provider}. Try again.`);
  }
  const upstreamHeadersMs = deps.now() - forwardedAt;
  const headers = new Headers(response.headers);
  for (const name of DROPPED_RESPONSE_HEADERS) headers.delete(name);
  const init = { status: response.status, statusText: response.statusText, headers };
  if (response.body === null) {
    record({ status: response.status, runId, authMs, upstreamHeadersMs });
    return new Response(null, init);
  }

  // Pulled chunk by chunk as the caller reads, so nothing is buffered, and logged
  // however the body ends: a harness drops the stream when its turn is interrupted.
  const reader = response.body.getReader();
  let firstChunkMs: number | null = null;
  let logged = false;
  const finish = (outcome: NonNullable<ModelGatewayRecord["outcome"]>) => {
    if (logged) return;
    logged = true;
    record({ status: response.status, runId, authMs, upstreamHeadersMs, firstChunkMs, outcome });
  };
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            finish("complete");
            controller.close();
            return;
          }
          firstChunkMs ??= deps.now() - forwardedAt;
          controller.enqueue(value);
        } catch (error) {
          finish("failed");
          controller.error(error);
        }
      },
      cancel(reason) {
        finish("cancelled");
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, init);
}
