import type { ClaudeIncomingRequestBodyLifecycle } from "./claudeBodyOwnership.ts";
import type {
  ClaudeAttemptResources,
  ClaudeRequestAttemptCounters,
  ClaudeRequestAttemptMarker,
  ClaudeRequestAttemptOutcome,
  ClaudeRequestAttemptStage,
  ClaudeRpcSnapshot,
} from "./claudeAttemptEvidence.ts";
export {
  CLAUDE_REQUEST_ATTEMPTS_KEY,
  CLAUDE_REQUEST_ATTEMPTS_PREFIX,
  claudeRequestAttemptKey,
} from "./claudeAttemptKeys.ts";
export type {
  ClaudeAttemptResources,
  ClaudeRequestAttemptCounters,
  ClaudeRequestAttemptMarker,
  ClaudeRequestAttemptOutcome,
  ClaudeRequestAttemptStage,
  ClaudeRpcSnapshot,
} from "./claudeAttemptEvidence.ts";

export function emptyClaudeAttemptResources(): ClaudeAttemptResources {
  return {
    transportEntered: false,
    incomingRequestBodyLifecycle: "not-owned",
    requestCaptureBytes: 0,
    responseCaptureBytes: 0,
    activeBufferedBytes: 0,
    peakBufferedBytes: 0,
    cumulativeBufferedBytes: 0,
    requestCaptureBodyLifecycle: "not-read",
    responseCaptureBodyLifecycle: "not-read",
    returnedResponseBodyLifecycle: "none",
  };
}

export function emptyClaudeRequestAttemptCounters(): ClaudeRequestAttemptCounters {
  return {
    schema: "signalbox/claude-request-attempt-counters/v1",
    nextOrdinal: 0,
    started: 0,
    activeRequests: 0,
    succeeded: 0,
    failed: 0,
    finalized: 0,
    transportEntered: 0,
    requestCaptureBytes: 0,
    responseCaptureBytes: 0,
    cumulativeBufferedBytes: 0,
    peakAttemptBufferedBytes: 0,
    requestCaptureBodiesConsumed: 0,
    requestCaptureBodiesCancelled: 0,
    requestCaptureBodiesErrored: 0,
    incomingRequestBodiesConsumed: 0,
    incomingRequestBodiesDelegatedUnverified: 0,
    incomingRequestBodiesCancelled: 0,
    incomingRequestBodiesCancelRequested: 0,
    incomingRequestBodiesCancelFailed: 0,
    requestCaptureBodiesCancelRequested: 0,
    requestCaptureBodiesCancelFailed: 0,
    responseCaptureBodiesConsumed: 0,
    responseCaptureBodiesCancelled: 0,
    responseCaptureBodiesCancelRequested: 0,
    responseCaptureBodiesCancelFailed: 0,
    responseCaptureBodiesErrored: 0,
    returnedResponseBodiesCancelled: 0,
    returnedResponseBodiesCancelRequested: 0,
    returnedResponseBodiesCancelFailed: 0,
  };
}

export function startClaudeRequestAttempt(
  counters: ClaudeRequestAttemptCounters,
  incomingRequestBodyLifecycle: ClaudeIncomingRequestBodyLifecycle,
  rpcStart: ClaudeRpcSnapshot,
): {
  readonly counters: ClaudeRequestAttemptCounters;
  readonly marker: ClaudeRequestAttemptMarker;
} {
  const ordinal = counters.nextOrdinal + 1;
  if (!Number.isSafeInteger(ordinal))
    throw new RangeError("Claude model request attempt ordinal is invalid.");
  return {
    counters: {
      ...counters,
      nextOrdinal: ordinal,
      started: counters.started + 1,
      activeRequests: counters.activeRequests + 1,
    },
    marker: {
      ordinal,
      state: "started",
      rpc: { scope: "cloud-rpc-module-global", start: rpcStart },
      resources: { ...emptyClaudeAttemptResources(), incomingRequestBodyLifecycle },
    },
  };
}

export function finishClaudeRequestAttempt(
  counters: ClaudeRequestAttemptCounters,
  marker: ClaudeRequestAttemptMarker,
  outcome: ClaudeRequestAttemptOutcome,
  resources: ClaudeAttemptResources,
  rpcEnd: ClaudeRpcSnapshot,
  failedAt?: ClaudeRequestAttemptStage,
): {
  readonly counters: ClaudeRequestAttemptCounters;
  readonly marker: ClaudeRequestAttemptMarker;
} {
  if (
    marker.state !== "started" ||
    counters.activeRequests < 1 ||
    (outcome === "failure" && failedAt === undefined) ||
    (outcome === "success" && failedAt !== undefined)
  )
    throw new Error("Claude request attempt cannot be finalized from its current state.");
  if (
    !Number.isSafeInteger(resources.requestCaptureBytes) ||
    !Number.isSafeInteger(resources.responseCaptureBytes) ||
    !Number.isSafeInteger(resources.activeBufferedBytes) ||
    !Number.isSafeInteger(resources.peakBufferedBytes) ||
    !Number.isSafeInteger(resources.cumulativeBufferedBytes) ||
    resources.requestCaptureBytes < 0 ||
    resources.responseCaptureBytes < 0 ||
    resources.activeBufferedBytes !== 0 ||
    resources.peakBufferedBytes < 0 ||
    resources.cumulativeBufferedBytes <
      resources.requestCaptureBytes + resources.responseCaptureBytes
  )
    throw new Error("Claude request attempt resource counters are invalid or still active.");

  const finalizedMarker: ClaudeRequestAttemptMarker = {
    ordinal: marker.ordinal,
    state: "finished",
    outcome,
    ...(failedAt === undefined ? {} : { failedAt }),
    finalized: true,
    rpc: { ...marker.rpc, end: rpcEnd },
    resources,
  };
  return {
    counters: {
      ...counters,
      activeRequests: counters.activeRequests - 1,
      succeeded: counters.succeeded + (outcome === "success" ? 1 : 0),
      failed: counters.failed + (outcome === "failure" ? 1 : 0),
      finalized: counters.finalized + 1,
      transportEntered: counters.transportEntered + (resources.transportEntered ? 1 : 0),
      requestCaptureBytes: counters.requestCaptureBytes + resources.requestCaptureBytes,
      responseCaptureBytes: counters.responseCaptureBytes + resources.responseCaptureBytes,
      cumulativeBufferedBytes: counters.cumulativeBufferedBytes + resources.cumulativeBufferedBytes,
      peakAttemptBufferedBytes: Math.max(
        counters.peakAttemptBufferedBytes,
        resources.peakBufferedBytes,
      ),
      requestCaptureBodiesConsumed:
        counters.requestCaptureBodiesConsumed +
        (resources.requestCaptureBodyLifecycle === "consumed" ? 1 : 0),
      requestCaptureBodiesCancelled:
        counters.requestCaptureBodiesCancelled +
        (resources.requestCaptureBodyLifecycle === "cancelled" ? 1 : 0),
      requestCaptureBodiesErrored:
        counters.requestCaptureBodiesErrored +
        (resources.requestCaptureBodyLifecycle === "errored" ? 1 : 0),
      requestCaptureBodiesCancelRequested:
        counters.requestCaptureBodiesCancelRequested +
        (resources.requestCaptureBodyLifecycle === "cancel-requested" ? 1 : 0),
      requestCaptureBodiesCancelFailed:
        counters.requestCaptureBodiesCancelFailed +
        (resources.requestCaptureBodyLifecycle === "cancel-failed" ? 1 : 0),
      incomingRequestBodiesConsumed:
        counters.incomingRequestBodiesConsumed +
        (resources.incomingRequestBodyLifecycle === "consumed" ? 1 : 0),
      incomingRequestBodiesDelegatedUnverified:
        counters.incomingRequestBodiesDelegatedUnverified +
        (resources.incomingRequestBodyLifecycle === "delegated-unverified" ? 1 : 0),
      incomingRequestBodiesCancelled:
        counters.incomingRequestBodiesCancelled +
        (resources.incomingRequestBodyLifecycle === "cancelled" ? 1 : 0),
      incomingRequestBodiesCancelRequested:
        counters.incomingRequestBodiesCancelRequested +
        (resources.incomingRequestBodyLifecycle === "cancel-requested" ? 1 : 0),
      incomingRequestBodiesCancelFailed:
        counters.incomingRequestBodiesCancelFailed +
        (resources.incomingRequestBodyLifecycle === "cancel-failed" ? 1 : 0),
      responseCaptureBodiesConsumed:
        counters.responseCaptureBodiesConsumed +
        (resources.responseCaptureBodyLifecycle === "consumed" ? 1 : 0),
      responseCaptureBodiesCancelled:
        counters.responseCaptureBodiesCancelled +
        (resources.responseCaptureBodyLifecycle === "cancelled" ? 1 : 0),
      responseCaptureBodiesCancelRequested:
        counters.responseCaptureBodiesCancelRequested +
        (resources.responseCaptureBodyLifecycle === "cancel-requested" ? 1 : 0),
      responseCaptureBodiesCancelFailed:
        counters.responseCaptureBodiesCancelFailed +
        (resources.responseCaptureBodyLifecycle === "cancel-failed" ? 1 : 0),
      responseCaptureBodiesErrored:
        counters.responseCaptureBodiesErrored +
        (resources.responseCaptureBodyLifecycle === "errored" ? 1 : 0),
      returnedResponseBodiesCancelled:
        counters.returnedResponseBodiesCancelled +
        (resources.returnedResponseBodyLifecycle === "cancelled" ? 1 : 0),
      returnedResponseBodiesCancelRequested:
        counters.returnedResponseBodiesCancelRequested +
        (resources.returnedResponseBodyLifecycle === "cancel-requested" ? 1 : 0),
      returnedResponseBodiesCancelFailed:
        counters.returnedResponseBodiesCancelFailed +
        (resources.returnedResponseBodyLifecycle === "cancel-failed" ? 1 : 0),
    },
    marker: finalizedMarker,
  };
}
