import * as Schema from "effect/Schema";

// https://developers.cloudflare.com/workers/platform/limits/#worker-startup-time
export const WORKER_STARTUP_LIMIT_MS = 1_000;
// One upload measured 178.898 ms locally and 448 ms remotely (~2.5x).
// 300 ms leaves margin below the remote limit; recalibrate as more uploads report timings.
export const WORKER_STARTUP_BUDGET_MS = 300;

const NonNegative = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const Profile = Schema.Struct({
  startTime: NonNegative,
  endTime: NonNegative,
  nodes: Schema.Array(
    Schema.Struct({
      id: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
      callFrame: Schema.Struct({ functionName: Schema.String }),
    }),
  ),
  samples: Schema.Array(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
  timeDeltas: Schema.Array(Schema.Int),
});
const decodeProfile = Schema.decodeUnknownSync(Profile);

/** V8 intervals vary. Idle samples do not count as active startup; garbage collection does. */
export function startupProfileSummary(raw: unknown) {
  const profile = decodeProfile(raw);
  const nodes = new Map(profile.nodes.map((node) => [node.id, node.callFrame.functionName]));
  if (
    !profile.samples.length ||
    profile.samples.length !== profile.timeDeltas.length ||
    nodes.size !== profile.nodes.length ||
    profile.endTime <= profile.startTime
  )
    throw new Error("WORKER_STARTUP_PROFILE_INVALID");
  let timestamp = profile.startTime;
  let negativeDeltaCount = 0;
  // V8 can serialize samples out of timestamp order. Keep their IDs paired while sorting,
  // as DevTools' CPUProfileDataModel does, before attributing adjacent intervals.
  const samples = profile.samples
    .map((id, index) => {
      const delta = profile.timeDeltas[index]!;
      if (delta < 0) negativeDeltaCount++;
      timestamp += delta;
      if (
        !Number.isFinite(timestamp) ||
        timestamp < profile.startTime ||
        timestamp > profile.endTime
      )
        throw new Error("WORKER_STARTUP_PROFILE_INVALID_TIMESTAMP");
      const name = nodes.get(id);
      if (name === undefined) throw new Error("WORKER_STARTUP_PROFILE_UNKNOWN_SAMPLE");
      return { timestamp, name };
    })
    .sort((a, b) => a.timestamp - b.timestamp);
  // DevTools estimates the last sample's duration from the mean interval. A lone
  // sample has no adjacent interval, so retain its recorded interval from startTime.
  const lastInterval =
    samples.length === 1
      ? samples[0]!.timestamp - profile.startTime
      : (samples.at(-1)!.timestamp - samples[0]!.timestamp) / (samples.length - 1);
  let sampledUs = 0;
  let idleUs = 0;
  let garbageCollectionUs = 0;
  for (const [index, sample] of samples.entries()) {
    const next = samples[index + 1];
    const interval = next === undefined ? lastInterval : next.timestamp - sample.timestamp;
    sampledUs += interval;
    if (sample.name === "(idle)") idleUs += interval;
    if (sample.name === "(garbage collector)") garbageCollectionUs += interval;
  }
  const activeUs = sampledUs - idleUs;
  if (!Number.isFinite(sampledUs) || activeUs <= 0)
    throw new Error("WORKER_STARTUP_PROFILE_NO_ACTIVE_SAMPLES");
  return {
    sampleCount: profile.samples.length,
    negativeDeltaCount,
    profileWindowMs: (profile.endTime - profile.startTime) / 1_000,
    sampledMs: sampledUs / 1_000,
    idleMs: idleUs / 1_000,
    activeMs: activeUs / 1_000,
    garbageCollectionMs: garbageCollectionUs / 1_000,
  };
}

export function requireStartupBudget(raw: unknown) {
  const summary = startupProfileSummary(raw);
  if (summary.activeMs > WORKER_STARTUP_BUDGET_MS)
    throw new Error(
      `WORKER_STARTUP_BUDGET_EXCEEDED: ${summary.activeMs} ms exceeds ${WORKER_STARTUP_BUDGET_MS} ms`,
    );
  return summary;
}
