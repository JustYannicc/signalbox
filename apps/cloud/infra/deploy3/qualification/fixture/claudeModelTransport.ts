import { CLAUDE_QUALIFICATION_API_REVISION } from "./claudeConfiguration.ts";
import {
  emptyClaudeAttemptResources,
  type ClaudeAttemptResources,
} from "./claudeAttemptCounters.ts";
import { cancelClaudeBodyQuick, cancelClaudeIncomingRequestBody } from "./claudeBodyOwnership.ts";

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

export type ClaudeWorkloadResourceObserver = (resources: ClaudeAttemptResources) => void;

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
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

  return async (
    request: Request,
    observeResources?: ClaudeWorkloadResourceObserver,
  ): Promise<Response> => {
    const resources: {
      -readonly [Key in keyof ClaudeAttemptResources]: ClaudeAttemptResources[Key];
    } = {
      ...emptyClaudeAttemptResources(),
      transportEntered: true,
      incomingRequestBodyLifecycle: request.body === null ? "not-owned" : "owned",
    };
    let requestBytes: Uint8Array | undefined;
    let responseBytes: Uint8Array | undefined;
    let response: Response | undefined;
    let responseReturned = false;
    let current: number | undefined;
    let path = "";
    let failed = false;
    let error: unknown;

    const captureBuffer = (kind: "request" | "response", bytes: Uint8Array) => {
      resources.activeBufferedBytes += bytes.byteLength;
      resources.cumulativeBufferedBytes += bytes.byteLength;
      resources.peakBufferedBytes = Math.max(
        resources.peakBufferedBytes,
        resources.activeBufferedBytes,
      );
      if (kind === "request") {
        resources.requestCaptureBytes += bytes.byteLength;
        resources.requestCaptureBodyLifecycle = "consumed";
      } else {
        resources.responseCaptureBytes += bytes.byteLength;
        resources.responseCaptureBodyLifecycle = "consumed";
      }
    };
    try {
      const url = new URL(request.url);
      path = `${url.pathname}${url.search}`;
      const countTokens = url.pathname === "/v1/messages/count_tokens";
      if (request.method !== "POST" || (url.pathname !== "/v1/messages" && !countTokens))
        throw new TypeError("Claude qualification only admits Messages API requests.");
      current = ++ordinal;

      const requestClone = request.clone();
      try {
        requestBytes = new Uint8Array(await requestClone.arrayBuffer());
        captureBuffer("request", requestBytes);
      } catch (cause) {
        resources.requestCaptureBodyLifecycle = "errored";
        const cancellation = await cancelClaudeBodyQuick(requestClone.body);
        if (cancellation.lifecycle !== "not-owned" && cancellation.lifecycle !== "consumed")
          resources.requestCaptureBodyLifecycle = cancellation.lifecycle;
        if (cancellation.lifecycle === "cancel-failed")
          throw new AggregateError(
            [cause, cancellation.cause],
            "Claude request capture and cleanup failed",
            { cause },
          );
        throw cause;
      }

      let model: string | undefined;
      let stream = false;
      let messageCount = 0;
      try {
        ({ model, stream, messageCount } = requestModel(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(requestBytes)),
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
        path,
        bodyBytes: requestBytes.byteLength,
        bodySha256: await sha256(requestBytes),
        model,
        stream,
        messageCount,
        anthropicVersion: request.headers.get("anthropic-version"),
      };
      await input.record(
        {
          ...identity,
          phase: "request",
          wireBytes: requestBytes.byteLength,
          wireSha256: identity.bodySha256,
        },
        requestBytes,
      );

      response = await input.fetch(request);
      resources.incomingRequestBodyLifecycle =
        request.body === null
          ? "not-owned"
          : request.bodyUsed
            ? "consumed"
            : "delegated-unverified";
      let responseClone: Response | undefined;
      try {
        responseClone = response.clone();
        responseBytes = new Uint8Array(await responseClone.arrayBuffer());
        captureBuffer("response", responseBytes);
      } catch (cause) {
        resources.responseCaptureBodyLifecycle = "errored";
        if (responseClone?.body) {
          const cancellation = await cancelClaudeBodyQuick(responseClone.body);
          if (cancellation.lifecycle !== "not-owned" && cancellation.lifecycle !== "consumed")
            resources.responseCaptureBodyLifecycle = cancellation.lifecycle;
          if (cancellation.lifecycle === "cancel-failed")
            throw new AggregateError(
              [cause, cancellation.cause],
              "Claude response capture and cleanup failed",
              { cause },
            );
        }
        throw cause;
      }
      await input.record(
        {
          purpose: "qualification",
          apiRevision: input.apiRevision,
          collectorNonce: input.collectorNonce,
          ordinal: current,
          phase: "response",
          method: request.method,
          path,
          status: response.status,
          contentType: response.headers.get("content-type"),
          requestId: response.headers.get("request-id"),
          wireBytes: responseBytes.byteLength,
          wireSha256: await sha256(responseBytes),
          ...(input.modelEvidence === undefined ? {} : { modelEvidence: input.modelEvidence() }),
        },
        responseBytes,
      );
      responseReturned = true;
      resources.returnedResponseBodyLifecycle = response.body === null ? "none" : "caller-owned";
    } catch (cause) {
      failed = true;
      error = cause;
      if (current !== undefined) {
        try {
          await input.record({
            purpose: "qualification",
            apiRevision: input.apiRevision,
            collectorNonce: input.collectorNonce,
            ordinal: current,
            phase: "failure",
            method: request.method,
            path,
            failure:
              cause instanceof DOMException && cause.name === "AbortError"
                ? "aborted"
                : "peer-failed",
            ...(input.modelEvidence === undefined ? {} : { modelEvidence: input.modelEvidence() }),
          });
        } catch (recordError) {
          error = new AggregateError(
            [cause, recordError],
            "Claude workload request failed and its failure record could not be persisted",
            { cause },
          );
        }
      }
    } finally {
      resources.activeBufferedBytes -= requestBytes?.byteLength ?? 0;
      requestBytes = undefined;
      resources.activeBufferedBytes -= responseBytes?.byteLength ?? 0;
      responseBytes = undefined;
      if (resources.activeBufferedBytes !== 0) {
        failed = true;
        error ??= new Error("Claude workload transport retained a request or response buffer.");
        resources.activeBufferedBytes = 0;
      }
      if (!responseReturned && resources.incomingRequestBodyLifecycle !== "not-owned") {
        const cancellation = await cancelClaudeIncomingRequestBody(request);
        resources.incomingRequestBodyLifecycle = cancellation.lifecycle;
        if (cancellation.lifecycle === "cancel-failed") {
          const cleanupError = cancellation.cause;
          error = failed
            ? new AggregateError([error, cleanupError], "Claude request and input cleanup failed", {
                cause: error,
              })
            : cleanupError;
          failed = true;
        }
      }
      if (response && !responseReturned && response.body !== null) {
        const cancellation = await cancelClaudeBodyQuick(response.body);
        if (cancellation.lifecycle !== "not-owned" && cancellation.lifecycle !== "consumed")
          resources.returnedResponseBodyLifecycle = cancellation.lifecycle;
        if (cancellation.lifecycle === "cancel-failed") {
          const cleanupError = cancellation.cause;
          error = failed
            ? new AggregateError(
                [error, cleanupError],
                "Claude request and response cleanup failed",
                {
                  cause: error,
                },
              )
            : cleanupError;
          failed = true;
        }
      }
      try {
        observeResources?.({ ...resources });
      } catch {
        // Resource observers must not change the request outcome.
      }
    }

    if (failed) throw error;
    if (!response) throw new Error("Claude workload transport completed without a response.");
    return response;
  };
}
