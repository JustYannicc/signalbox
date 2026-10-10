import {
  MODEL_GATEWAY_PATHS,
  type ModelGatewayProvider,
} from "@signalbox/runner-protocol/RunnerProtocol";

import type { ModelServeReply } from "../thread/runner/modelGrants.ts";
import { threadOfModelToken } from "../thread/runner/modelToken.ts";
import type { ModelGatewayRecord } from "./modelGatewayRecord.ts";
import { makeUsageScanner } from "./usageScanner.ts";

/**
 * The ModelGateway: how a turn reaches its pool's accounts. Harnesses on a
 * machine call it as their provider's API (Claude Code through
 * `ANTHROPIC_BASE_URL`, Codex through a custom provider's `base_url`) with a
 * model token instead of a key, exactly as they would call a pool's
 * CLIProxyAPI. Each request is checked with the token's thread, which grants
 * it only while the turn the token was minted for is running and names the
 * turn's pool. The pool's object then checks the requester may still use the
 * pool and sends the request to its CLIProxyAPI with the pool's client key.
 * The response streams back as it arrives. No key or credential ever reaches
 * the gateway or the machine.
 *
 * Only the endpoints a harness needs for a turn are served, so a token is no
 * use for anything else the pool could do.
 */

export interface ModelGatewayDeps {
  /**
   * Checks the token and, granted, sends the request to the turn's pool
   * (`ModelGrants.serve`). Throws when the token could not be checked.
   * `path` includes the query.
   */
  readonly serve: (
    token: string,
    provider: ModelGatewayProvider,
    path: string,
    request: Request,
  ) => Promise<ModelServeReply>;
  readonly now: () => number;
  readonly log: (record: ModelGatewayRecord) => void;
}

const SERVED_PATHS: Readonly<Record<ModelGatewayProvider, ReadonlyArray<string>>> = {
  anthropic: ["/v1/messages", "/v1/models"],
  openai: ["/v1/responses", "/v1/models"],
};

const PROVIDERS = Object.keys(MODEL_GATEWAY_PATHS) as ReadonlyArray<ModelGatewayProvider>;

/** Headers that carry the caller's credential, or describe the hop rather than the request. The pool adds its own key. */
const DROPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "host",
  "cookie",
  "content-length",
]);
/** The runtime decodes the upstream body, so its encoding and length no longer apply. */
const DROPPED_RESPONSE_HEADERS = ["content-encoding", "content-length", "transfer-encoding"];

const ANTHROPIC_ERROR_TYPES: Readonly<Record<number, string>> = {
  401: "authentication_error",
  403: "permission_error",
};

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
          error: { type: ANTHROPIC_ERROR_TYPES[status] ?? "api_error", message },
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

function withoutCaller(source: Headers) {
  const headers = new Headers();
  for (const [name, value] of source) {
    const dropped =
      DROPPED_REQUEST_HEADERS.has(name) ||
      name.startsWith("cf-") ||
      name.startsWith("x-forwarded-");
    if (!dropped) headers.append(name, value);
  }
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

  const startedAt = deps.now();
  const threadId = threadOfModelToken(token);
  const record = (fields: Partial<ModelGatewayRecord> & Pick<ModelGatewayRecord, "status">) =>
    deps.log({
      provider,
      method: request.method,
      path,
      threadId,
      runId: null,
      traceId: null,
      authMs: 0,
      upstreamHeadersMs: null,
      firstChunkMs: null,
      addedMs: null,
      totalMs: deps.now() - startedAt,
      model: null,
      usage: null,
      ...fields,
    });

  const forwarded: RequestInit & { readonly duplex: "half" } = {
    method: request.method,
    headers: withoutCaller(request.headers),
    body: request.body,
    redirect: "manual",
    // The request body streams through rather than being buffered (Node requires saying so).
    duplex: "half",
  };
  let served: ModelServeReply;
  try {
    served = await deps.serve(
      token,
      provider,
      `${path}${url.search}`,
      new Request(request.url, forwarded),
    );
  } catch {
    record({ status: 503, authMs: deps.now() - startedAt });
    return errorResponse(provider, 503, "Could not check the model token. Try again.");
  }
  const { authMs } = served;
  if (served._tag === "denied") {
    record({ status: 401, authMs, denied: served.reason });
    return errorResponse(provider, 401, served.reason);
  }
  const { runId, traceId, reply } = served;
  if (reply._tag === "denied") {
    record({ status: 403, runId, traceId, authMs, denied: reply.reason });
    return errorResponse(provider, 403, reply.reason);
  }
  if (reply._tag === "failed") {
    record({ status: 502, runId, traceId, authMs, outcome: "failed" });
    return errorResponse(provider, 502, `This thread's pool is unavailable: ${reply.reason}`);
  }
  const { response } = reply;
  const headersMs = deps.now() - startedAt;
  const upstreamHeadersMs = headersMs - authMs;
  // Everything before the pool's CLIProxyAPI answered that it did not spend itself:
  // the token check, the hops to the pool, its access check and a cold container's start.
  const addedMs = Math.max(0, headersMs - reply.upstreamMs);
  const headers = new Headers(response.headers);
  for (const name of DROPPED_RESPONSE_HEADERS) headers.delete(name);
  const init = { status: response.status, statusText: response.statusText, headers };
  if (response.body === null) {
    record({ status: response.status, runId, traceId, authMs, upstreamHeadersMs, addedMs });
    return new Response(null, init);
  }

  // Pulled chunk by chunk as the caller reads, so nothing is buffered, and logged
  // however the body ends: a harness drops the stream when its turn is interrupted.
  const reader = response.body.getReader();
  // `/v1/models` reports no usage.
  const scanner = makeUsageScanner(
    provider,
    path.startsWith("/v1/models") ? null : response.headers.get("content-type"),
  );
  let firstChunkMs: number | null = null;
  let logged = false;
  const finish = (outcome: NonNullable<ModelGatewayRecord["outcome"]>) => {
    if (logged) return;
    logged = true;
    const { model, usage } = scanner.finish();
    record({
      status: response.status,
      runId,
      traceId,
      authMs,
      upstreamHeadersMs,
      firstChunkMs,
      addedMs,
      outcome,
      model,
      usage,
    });
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
          firstChunkMs ??= deps.now() - startedAt - authMs;
          controller.enqueue(value);
          // After the chunk is on its way, so reading usage never delays it.
          scanner.push(value);
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
