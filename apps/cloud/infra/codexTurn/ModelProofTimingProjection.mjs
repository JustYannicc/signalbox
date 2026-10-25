const PHASES = new Set(["/startup", "/turn", "/model-proof-records", "other"]);
const OUTCOMES = new Set([
  "ok",
  "exception",
  "exceededCpu",
  "exceededMemory",
  "canceled",
  "unknown",
]);
const EXECUTION_MODELS = new Set(["durableObject", "stateless"]);
const TRACE_ID = /^[a-f0-9]{16}$/;

function finiteNativeTime(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function phaseFor(trace) {
  try {
    const path = new URL(trace?.event?.request?.url).pathname;
    return PHASES.has(path) ? path : "other";
  } catch {
    return "other";
  }
}

/** Projects native TraceItem data into the fields retained by the proof collector. */
export function nativeTimingRecord(trace, props) {
  return {
    traceId: TRACE_ID.test(props?.traceId ?? "") ? props.traceId : "unclassified",
    layer: props?.layer === "facet" ? "facet" : "other",
    phase: phaseFor(trace),
    eventTimestamp: finiteNativeTime(trace?.eventTimestamp),
    cpuTime: finiteNativeTime(trace?.cpuTime),
    wallTime: finiteNativeTime(trace?.wallTime),
    outcome: OUTCOMES.has(trace?.outcome) ? trace.outcome : "other",
    executionModel: EXECUTION_MODELS.has(trace?.executionModel) ? trace.executionModel : "other",
    truncated: trace?.truncated === true,
  };
}

/** Rebuilds an allowlisted row at the storage boundary, dropping all other fields. */
export function nativeTimingRow(record) {
  return {
    traceId: TRACE_ID.test(record?.traceId ?? "") ? record.traceId : "unclassified",
    layer: record?.layer === "facet" ? "facet" : "other",
    phase: PHASES.has(record?.phase) ? record.phase : "other",
    eventTimestamp: finiteNativeTime(record?.eventTimestamp),
    cpuTime: finiteNativeTime(record?.cpuTime),
    wallTime: finiteNativeTime(record?.wallTime),
    outcome: OUTCOMES.has(record?.outcome) ? record.outcome : "other",
    executionModel: EXECUTION_MODELS.has(record?.executionModel) ? record.executionModel : "other",
    truncated: record?.truncated === true,
  };
}
