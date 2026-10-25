import type { ModelGatewayProvider } from "@signalbox/runner-protocol/RunnerProtocol";

/**
 * Where a local key travels when the harness keeps its own sign-in in
 * `Authorization` (Codex with `requires_openai_auth`, `localKeys/localSetup.ts`).
 */
export const LOCAL_KEY_HEADER = "x-signalbox-key";

/**
 * Headers that say who the caller is: their credentials, and the ChatGPT
 * account a signed-in Codex names. None reaches the pool, which adds its own
 * key and runs on its own accounts.
 */
const CALLER_HEADERS = [
  "authorization",
  "x-api-key",
  LOCAL_KEY_HEADER,
  "chatgpt-account-id",
  "cookie",
] as const;

/** The caller's headers, and those that describe the hop rather than the request. */
const DROPPED_REQUEST_HEADERS = new Set<string>([...CALLER_HEADERS, "host", "content-length"]);

/** Which caller headers a request carried, by name only, for its record. */
export const callerHeadersOf = (headers: Headers) =>
  CALLER_HEADERS.filter((name) => headers.has(name));
const ANTHROPIC_ERROR_TYPES: Readonly<Record<number, string>> = {
  401: "authentication_error",
  403: "permission_error",
};

/** An error in the shape the provider's own API uses, so the harness shows the message. */
export function errorResponse(
  provider: ModelGatewayProvider | null,
  status: number,
  message: string,
) {
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

export function bearerOrKey(headers: Headers): string | null {
  // A local key in its own header wins: `Authorization` then holds the harness's own sign-in.
  const localKey = headers.get(LOCAL_KEY_HEADER);
  if (localKey !== null && localKey !== "") return localKey;
  const key = headers.get("x-api-key");
  if (key !== null && key !== "") return key;
  const authorization = headers.get("authorization");
  const match = authorization === null ? null : /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1] ?? null;
}

/** The request headers worth forwarding upstream: no credential, nothing about this hop. */
export function withoutCaller(source: Headers) {
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
