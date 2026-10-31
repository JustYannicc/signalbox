import { CLAUDE_QUALIFICATION_API_REVISION } from "./claudeConfiguration.ts";

export interface ClaudeWorkloadRecord {
  readonly purpose: "qualification";
  readonly apiRevision: typeof CLAUDE_QUALIFICATION_API_REVISION;
  readonly collectorNonce: string;
  readonly ordinal: number;
  readonly phase: "request" | "response" | "failure";
  readonly method: string;
  readonly path: string;
  readonly bodyBytes?: number;
  readonly bodySha256?: string;
  readonly model?: string;
  readonly messageCount?: number;
  readonly anthropicVersion?: string | null;
  readonly stream?: boolean;
  readonly status?: number;
  readonly contentType?: string | null;
  readonly requestId?: string | null;
  readonly wireBytes?: number;
  readonly wireSha256?: string;
  readonly modelEvidence?: unknown;
  readonly failure?: string;
}

export interface ClaudeWorkloadTransportInput {
  readonly collectorNonce: string;
  readonly apiRevision: typeof CLAUDE_QUALIFICATION_API_REVISION;
  readonly fetch: (request: Request) => Promise<Response>;
  /** Persists metadata and the exact wire body as one artifact before the request proceeds. */
  readonly record: (record: ClaudeWorkloadRecord, wire?: Uint8Array) => Promise<unknown>;
  readonly modelEvidence?: () => unknown;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requestModel(
  body: unknown,
  countTokens: boolean,
): { model: string; stream: boolean; messageCount: number } {
  if (body === null || typeof body !== "object" || Array.isArray(body))
    throw new TypeError("Claude workload request must have a JSON object body.");
  const model = Reflect.get(body, "model");
  const stream = Reflect.get(body, "stream");
  const messages = Reflect.get(body, "messages");
  if (typeof model !== "string" || model.length === 0)
    throw new TypeError("Claude workload request has no model identity.");
  if (!countTokens && (!Array.isArray(messages) || messages.length === 0))
    throw new TypeError("Claude workload request has no conversation messages.");
  if (countTokens && messages !== undefined && !Array.isArray(messages))
    throw new TypeError("Claude token-count request messages are invalid.");
  if (stream !== undefined && typeof stream !== "boolean")
    throw new TypeError("Claude workload stream flag is invalid.");
  return {
    model,
    stream: stream === true,
    messageCount: Array.isArray(messages) ? messages.length : 0,
  };
}

/** Adds run-local collector evidence while forwarding the untouched request to the model peer. */
export function createClaudeWorkloadTransport(input: ClaudeWorkloadTransportInput) {
  if (input.collectorNonce.trim() === "")
    throw new TypeError("Claude collector nonce is required.");
  if (input.apiRevision !== CLAUDE_QUALIFICATION_API_REVISION)
    throw new TypeError("Claude workload collector revision is unsupported.");
  let ordinal = 0;

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const countTokens = url.pathname === "/v1/messages/count_tokens";
    if (request.method !== "POST" || (url.pathname !== "/v1/messages" && !countTokens))
      throw new TypeError("Claude qualification only admits Messages API requests.");
    const current = ++ordinal;
    const bodyBytes = new Uint8Array(await request.clone().arrayBuffer());
    let model: string | undefined;
    let stream = false;
    let messageCount = 0;
    try {
      ({ model, stream, messageCount } = requestModel(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes)),
        countTokens,
      ));
    } catch (cause) {
      throw new TypeError("Claude workload request body is invalid.", { cause });
    }
    const identity = {
      purpose: "qualification" as const,
      apiRevision: input.apiRevision,
      collectorNonce: input.collectorNonce,
      ordinal: current,
      method: request.method,
      path: `${url.pathname}${url.search}`,
      bodyBytes: bodyBytes.byteLength,
      bodySha256: await sha256(bodyBytes),
      model,
      stream,
      messageCount,
      anthropicVersion: request.headers.get("anthropic-version"),
    };
    await input.record(
      {
        ...identity,
        phase: "request",
        wireBytes: bodyBytes.byteLength,
        wireSha256: identity.bodySha256,
      },
      bodyBytes,
    );

    try {
      const response = await input.fetch(request);
      const responseBytes = new Uint8Array(await response.clone().arrayBuffer());
      await input.record(
        {
          purpose: "qualification",
          apiRevision: input.apiRevision,
          collectorNonce: input.collectorNonce,
          ordinal: current,
          phase: "response",
          method: request.method,
          path: `${url.pathname}${url.search}`,
          status: response.status,
          contentType: response.headers.get("content-type"),
          requestId: response.headers.get("request-id"),
          wireBytes: responseBytes.byteLength,
          wireSha256: await sha256(responseBytes),
          ...(input.modelEvidence === undefined ? {} : { modelEvidence: input.modelEvidence() }),
        },
        responseBytes,
      );
      return response;
    } catch (cause) {
      await input.record({
        purpose: "qualification",
        apiRevision: input.apiRevision,
        collectorNonce: input.collectorNonce,
        ordinal: current,
        phase: "failure",
        method: request.method,
        path: `${url.pathname}${url.search}`,
        failure:
          cause instanceof DOMException && cause.name === "AbortError" ? "aborted" : "peer-failed",
        ...(input.modelEvidence === undefined ? {} : { modelEvidence: input.modelEvidence() }),
      });
      throw cause;
    }
  };
}
