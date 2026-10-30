import { deriveHarnessReleaseInheritedReachability } from "./harnessReleaseInheritedReachability.ts";

const inheritedReachability = deriveHarnessReleaseInheritedReachability;

export interface ExpectedHarnessReleaseBuiltinPins {
  readonly environment: "local-workerd" | "deployed";
  readonly artifactSha256: string;
  readonly measurementRunId?: string;
}

/** Recompute the serialized guard disposition from its complete inventory and capture records. */
export const isHarnessReleaseBuiltinCriteriaAssessment = (
  value: unknown,
  expected: ExpectedHarnessReleaseBuiltinPins,
) => {
  const record = (input: unknown): Record<string, unknown> | undefined =>
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined;
  const text = (input: unknown): input is string => typeof input === "string" && input.length > 0;
  const hash = (input: unknown): input is string =>
    typeof input === "string" && /^[a-f0-9]{64}$/u.test(input);
  const natural = (input: unknown): input is number =>
    typeof input === "number" && Number.isSafeInteger(input) && input >= 0;
  const rows = (input: unknown): Record<string, unknown>[] | undefined => {
    if (!Array.isArray(input)) return undefined;
    const result = input.map(record);
    return result.every((row) => row !== undefined) ? result : undefined;
  };
  const samePath = (left: unknown, right: unknown) =>
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((part, index) => text(part) && part === right[index]);
  const assessment = record(value);
  const deployed = expected.environment === "deployed";
  if (
    !assessment ||
    assessment.schemaVersion !== 1 ||
    !hash(expected.artifactSha256) ||
    assessment.artifactSha256 !== expected.artifactSha256 ||
    (assessment.coverageStatus !== "passed" &&
      !(assessment.coverageStatus === "pending" && !deployed)) ||
    !Array.isArray(assessment.blockers) ||
    assessment.blockers.length !== 0
  )
    return false;
  const observation = record(assessment.observation);
  if (
    !observation ||
    observation.method !== "reached by executed range" ||
    !text(observation.limitation)
  )
    return false;
  const evidence = record(assessment.evidence);
  const inventory = record(evidence?.inventory);
  const corpus = record(evidence?.corpus);
  if (
    !inventory ||
    inventory.schemaVersion !== 1 ||
    !corpus ||
    corpus.schemaVersion !== 1 ||
    ![
      inventory.missingBuiltins,
      inventory.unknownBuiltinSpecifiers,
      inventory.ambiguities,
      inventory.functionAmbiguities,
    ].every((items) => Array.isArray(items) && items.length === 0)
  )
    return false;
  const sources = rows(inventory.sourceFiles);
  const calls = rows(inventory.callSites);
  const analysis = rows(inventory.analysisOnlyCallSites);
  const runs = rows(corpus.runs);
  const obligations = rows(assessment.openObligations);
  const reportedReached = rows(assessment.reachedSites);
  const unmapped = rows(assessment.unmappedAnalysisSites);
  if (!sources || !calls || !analysis || !runs || !obligations || !reportedReached || !unmapped)
    return false;
  const sourceByName = new Map<string, Record<string, unknown>>();
  for (const source of sources) {
    if (
      !text(source.name) ||
      !hash(source.sha256) ||
      !natural(source.bytes) ||
      !natural(source.sourceUtf16Length) ||
      sourceByName.has(source.name)
    )
      return false;
    sourceByName.set(source.name, source);
  }
  const callById = new Map<string, Record<string, unknown>>();
  for (const call of calls) {
    const source = text(call.module) ? sourceByName.get(call.module) : undefined;
    if (
      !source ||
      !hash(call.siteId) ||
      callById.has(call.siteId) ||
      call.sourceSha256 !== source.sha256 ||
      call.offsetUnit !== "utf16-code-units" ||
      !natural(call.startOffset) ||
      !natural(call.endOffset) ||
      call.startOffset >= call.endOffset ||
      call.endOffset > Number(source.sourceUtf16Length) ||
      !text(call.specifier) ||
      !Array.isArray(call.memberPath) ||
      !call.memberPath.every(text) ||
      (call.status !== "supported" &&
        call.status !== "unsupported" &&
        call.status !== "platform-pruned")
    )
      return false;
    if (call.status === "unsupported") {
      const failure = record(call.failure);
      if (!failure || failure.kind !== "named-error" || !text(failure.code)) return false;
    }
    callById.set(call.siteId, call);
  }
  const inheritance = inheritedReachability(expected.artifactSha256, inventory, corpus);
  if (!inheritance) return false;
  const inheritedById = new Map(
    inheritance.inheritedSites.map((site) => [site.siteId, site.inheritedFrom]),
  );
  if (
    JSON.stringify(assessment.removedApiPaths ?? []) !== JSON.stringify(inheritance.removedApiPaths)
  )
    return false;
  const reached = new Set(inheritedById.keys());
  const runIds = new Set<string>();
  let qualifiedRunId: string | undefined;
  for (const run of runs) {
    if (
      !text(run.runId) ||
      runIds.has(run.runId) ||
      !hash(run.artifactSha256) ||
      !hash(run.evidenceSha256) ||
      (run.kind !== "a-series-replay" && run.kind !== "release-qualification") ||
      typeof run.completed !== "boolean" ||
      (run.captureState !== "complete" &&
        run.captureState !== "incomplete" &&
        run.captureState !== "not-started")
    )
      return false;
    runIds.add(run.runId);
    const runSources = rows(run.sources);
    if (!runSources) return false;
    if (run.artifactSha256 !== expected.artifactSha256) continue;
    const captured = run.captureState !== "not-started";
    const names = new Set<string>();
    let sourcesMatch = runSources.length === sources.length;
    for (const source of runSources) {
      if (!text(source.module) || names.has(source.module) || !hash(source.sourceSha256))
        return false;
      names.add(source.module);
      const pinned = sourceByName.get(source.module);
      if (!pinned || pinned.sha256 !== source.sourceSha256) sourcesMatch = false;
      const ranges = rows(source.executedByteRanges);
      if (!ranges || !Array.isArray(source.invokedSiteIds) || !source.invokedSiteIds.every(hash))
        return false;
      if (!captured && (ranges.length || source.invokedSiteIds.length)) return false;
      for (const range of ranges) {
        if (
          !natural(range.startOffset) ||
          !natural(range.endOffset) ||
          range.endOffset <= range.startOffset ||
          range.offsetUnit !== "utf16-code-units" ||
          !natural(range.executionCount) ||
          range.executionCount === 0 ||
          (pinned && range.endOffset > Number(pinned.sourceUtf16Length))
        )
          return false;
      }
    }
    if (run.kind === "release-qualification") {
      if (qualifiedRunId || !run.completed || run.captureState !== "complete" || !sourcesMatch)
        return false;
      if (
        sources.length > 0 &&
        !runSources.some(
          (source) =>
            (source.executedByteRanges as unknown[]).length > 0 ||
            (source.invokedSiteIds as unknown[]).length > 0,
        )
      )
        return false;
      qualifiedRunId = run.runId;
    }
    if (!captured || !sourcesMatch) continue;
    for (const source of runSources) {
      const invocations = source.invokedSiteIds as string[];
      if (new Set(invocations).size !== invocations.length) return false;
      for (const id of invocations) {
        const call = callById.get(id);
        if (!call || call.module !== source.module) return false;
        reached.add(id);
      }
      const ranges = rows(source.executedByteRanges)!;
      for (const [id, call] of callById) {
        if (
          call.module === source.module &&
          ranges.some(
            (range) =>
              Number(range.startOffset) < Number(call.endOffset) &&
              Number(range.endOffset) > Number(call.startOffset),
          )
        )
          reached.add(id);
      }
    }
  }
  if (
    deployed &&
    (!text(expected.measurementRunId) ||
      qualifiedRunId !== expected.measurementRunId ||
      assessment.qualifiedRunId !== expected.measurementRunId)
  )
    return false;
  const blockingAnalysis = analysis.filter((site) => site.status !== "supported");
  const allById = new Map([...calls, ...analysis].map((site) => [site.siteId, site]));
  if (allById.size !== calls.length + analysis.length) return false;
  if (assessment.coverageStatus === "passed" && (!qualifiedRunId || blockingAnalysis.length !== 0))
    return false;
  if (
    reportedReached.length !== reached.size ||
    new Set(reportedReached.map((site) => site.siteId)).size !== reached.size ||
    reportedReached.some(
      (site) =>
        !text(site.siteId) ||
        !reached.has(site.siteId) ||
        site.status !== "supported" ||
        allById.get(site.siteId)?.status !== "supported" ||
        JSON.stringify(site.inheritedFrom ?? []) !==
          JSON.stringify(inheritedById.get(site.siteId) ?? []),
    )
  )
    return false;
  const obligationById = new Map<string, Record<string, unknown>>();
  for (const obligation of obligations) {
    if (!hash(obligation.siteId) || obligationById.has(obligation.siteId)) return false;
    obligationById.set(obligation.siteId, obligation);
  }
  let unsupported = 0;
  for (const [id, call] of callById) {
    if (reached.has(id) && call.status !== "supported") return false;
    if (call.status !== "unsupported") continue;
    unsupported += 1;
    const obligation = obligationById.get(id);
    const failure = record(call.failure)!;
    if (
      !obligation ||
      obligation.kind !== "unsupported-fail-loud" ||
      obligation.module !== call.module ||
      obligation.specifier !== call.specifier ||
      !samePath(obligation.memberPath, call.memberPath) ||
      obligation.failureCode !== failure.code ||
      obligation.state !== (qualifiedRunId ? "unreached" : "awaiting-coverage")
    )
      return false;
  }
  if (obligations.length !== unsupported || unmapped.length !== blockingAnalysis.length)
    return false;
  const analysisIds = new Set(blockingAnalysis.map((site) => site.siteId));
  return (
    analysisIds.size === blockingAnalysis.length &&
    unmapped.every((site) => hash(site.siteId) && analysisIds.has(site.siteId))
  );
};
