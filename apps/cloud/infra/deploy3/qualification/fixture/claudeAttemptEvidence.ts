import * as Schema from "effect/Schema";
import { CLAUDE_INCOMING_REQUEST_BODY_LIFECYCLES } from "./claudeBodyOwnership.ts";
export {
  CLAUDE_REQUEST_ATTEMPTS_KEY,
  CLAUDE_REQUEST_ATTEMPTS_PREFIX,
  claudeRequestAttemptKey,
} from "./claudeAttemptKeys.ts";

const NonNegativeInteger = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const PositiveInteger = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const RequestAttemptOutcome = Schema.Literals(["success", "failure"]);
const RequestAttemptStage = Schema.Literals([
  "active-step",
  "credential",
  "first-failure",
  "model-owner",
  "transport",
]);
const RpcSnapshot = Schema.Struct({
  calls: NonNegativeInteger,
  activeCalls: NonNegativeInteger,
  peakCalls: NonNegativeInteger,
  acquiredResults: NonNegativeInteger,
  disposedResults: NonNegativeInteger,
  activeResults: NonNegativeInteger,
  activeStubs: NonNegativeInteger,
  disposedStubs: NonNegativeInteger,
  failedResultDisposals: NonNegativeInteger,
  failedStubDisposals: NonNegativeInteger,
  activeResponseBodies: NonNegativeInteger,
  activeResponseWebSockets: NonNegativeInteger,
  responseBodyBytes: NonNegativeInteger,
  heapBytes: Schema.Null,
  rssBytes: Schema.Null,
  memoryMeasurement: Schema.Literal("unavailable"),
});
const AttemptResources = Schema.Struct({
  transportEntered: Schema.Boolean,
  incomingRequestBodyLifecycle: Schema.Literals(CLAUDE_INCOMING_REQUEST_BODY_LIFECYCLES),
  /** Explicit capture arrays only; this is not a heap or RSS measurement. */
  requestCaptureBytes: NonNegativeInteger,
  responseCaptureBytes: NonNegativeInteger,
  activeBufferedBytes: NonNegativeInteger,
  peakBufferedBytes: NonNegativeInteger,
  cumulativeBufferedBytes: NonNegativeInteger,
  requestCaptureBodyLifecycle: Schema.Literals([
    "not-read",
    "consumed",
    "cancelled",
    "cancel-requested",
    "cancel-failed",
    "errored",
  ]),
  responseCaptureBodyLifecycle: Schema.Literals([
    "not-read",
    "consumed",
    "cancelled",
    "cancel-requested",
    "cancel-failed",
    "errored",
  ]),
  returnedResponseBodyLifecycle: Schema.Literals([
    "none",
    "caller-owned",
    "cancelled",
    "cancel-requested",
    "cancel-failed",
  ]),
});

export const ClaudeRequestAttemptCountersSchema = Schema.Struct({
  schema: Schema.Literal("signalbox/claude-request-attempt-counters/v1"),
  nextOrdinal: NonNegativeInteger,
  started: NonNegativeInteger,
  activeRequests: NonNegativeInteger,
  succeeded: NonNegativeInteger,
  failed: NonNegativeInteger,
  finalized: NonNegativeInteger,
  transportEntered: NonNegativeInteger,
  requestCaptureBytes: NonNegativeInteger,
  responseCaptureBytes: NonNegativeInteger,
  cumulativeBufferedBytes: NonNegativeInteger,
  peakAttemptBufferedBytes: NonNegativeInteger,
  requestCaptureBodiesConsumed: NonNegativeInteger,
  requestCaptureBodiesCancelled: NonNegativeInteger,
  requestCaptureBodiesErrored: NonNegativeInteger,
  incomingRequestBodiesConsumed: NonNegativeInteger,
  incomingRequestBodiesDelegatedUnverified: NonNegativeInteger,
  incomingRequestBodiesCancelled: NonNegativeInteger,
  incomingRequestBodiesCancelRequested: NonNegativeInteger,
  incomingRequestBodiesCancelFailed: NonNegativeInteger,
  requestCaptureBodiesCancelRequested: NonNegativeInteger,
  requestCaptureBodiesCancelFailed: NonNegativeInteger,
  responseCaptureBodiesConsumed: NonNegativeInteger,
  responseCaptureBodiesCancelled: NonNegativeInteger,
  responseCaptureBodiesCancelRequested: NonNegativeInteger,
  responseCaptureBodiesCancelFailed: NonNegativeInteger,
  responseCaptureBodiesErrored: NonNegativeInteger,
  returnedResponseBodiesCancelled: NonNegativeInteger,
  returnedResponseBodiesCancelRequested: NonNegativeInteger,
  returnedResponseBodiesCancelFailed: NonNegativeInteger,
});

export const ClaudeRequestAttemptMarkerSchema = Schema.Struct({
  ordinal: PositiveInteger,
  state: Schema.Literals(["started", "finished"]),
  outcome: Schema.optionalKey(RequestAttemptOutcome),
  failedAt: Schema.optionalKey(RequestAttemptStage),
  finalized: Schema.optionalKey(Schema.Literal(true)),
  rpc: Schema.Struct({
    scope: Schema.Literal("cloud-rpc-module-global"),
    start: RpcSnapshot,
    end: Schema.optionalKey(RpcSnapshot),
  }),
  resources: AttemptResources,
});

export type ClaudeRequestAttemptOutcome = typeof RequestAttemptOutcome.Type;
export type ClaudeRpcSnapshot = typeof RpcSnapshot.Type;
export type ClaudeRequestAttemptStage = typeof RequestAttemptStage.Type;
export type ClaudeAttemptResources = typeof AttemptResources.Type;
export type ClaudeRequestAttemptMarker = typeof ClaudeRequestAttemptMarkerSchema.Type;
export type ClaudeRequestAttemptCounters = typeof ClaudeRequestAttemptCountersSchema.Type;

const decodeCounters = Schema.decodeUnknownSync(ClaudeRequestAttemptCountersSchema);
const decodeMarker = Schema.decodeUnknownSync(ClaudeRequestAttemptMarkerSchema);

export function decodeClaudeRequestAttemptCounters(value: unknown) {
  const counters = decodeCounters(value);
  if (
    counters.nextOrdinal !== counters.started ||
    counters.started !== counters.finalized + counters.activeRequests ||
    counters.finalized !== counters.succeeded + counters.failed
  ) {
    throw new Error("Claude request attempt counters are inconsistent");
  }
  return counters;
}

export function decodeClaudeRequestAttemptMarker(value: unknown) {
  const marker = decodeMarker(value);
  const { resources } = marker;
  const validResources =
    resources.activeBufferedBytes === 0 &&
    resources.cumulativeBufferedBytes >=
      resources.requestCaptureBytes + resources.responseCaptureBytes;
  const validState =
    marker.state === "started"
      ? marker.outcome === undefined &&
        marker.failedAt === undefined &&
        marker.finalized === undefined &&
        marker.rpc.end === undefined
      : marker.outcome !== undefined &&
        marker.finalized === true &&
        marker.rpc.end !== undefined &&
        (marker.outcome === "failure"
          ? marker.failedAt !== undefined
          : marker.failedAt === undefined);
  if (!validResources || !validState) {
    throw new Error("Claude request attempt marker is inconsistent");
  }
  return marker;
}
