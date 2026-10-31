import * as Schema from "effect/Schema";

// https://developers.cloudflare.com/workers/platform/limits/#worker-startup-time
export const WORKER_STARTUP_LIMIT_MS = 1_000;
export const WORKER_STARTUP_BUDGET_MS = WORKER_STARTUP_LIMIT_MS / 2;

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
  timeDeltas: Schema.Array(NonNegative),
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
  let sampledUs = 0;
  let idleUs = 0;
  let garbageCollectionUs = 0;
  for (const [index, interval] of profile.timeDeltas.entries()) {
    const name = nodes.get(profile.samples[index]!);
    if (name === undefined) throw new Error("WORKER_STARTUP_PROFILE_UNKNOWN_SAMPLE");
    sampledUs += interval;
    if (name === "(idle)") idleUs += interval;
    if (name === "(garbage collector)") garbageCollectionUs += interval;
  }
  const activeUs = sampledUs - idleUs;
  if (!Number.isFinite(sampledUs) || activeUs <= 0)
    throw new Error("WORKER_STARTUP_PROFILE_NO_ACTIVE_SAMPLES");
  return {
    sampleCount: profile.samples.length,
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
