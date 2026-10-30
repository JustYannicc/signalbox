import { deriveHarnessReleaseInheritedReachability } from "@t3tools/shared/harnessReleaseInheritedReachability";
import {
  isNamedRuntimeFailure,
  type NodeBuiltinCoverageReport,
  type NodeBuiltinFunctionCall,
  type NodeBuiltinSourceInventory,
} from "./coverage.ts";
import {
  invalidReachabilityEvidence as invalid,
  isReachabilityHash as hash,
  parseBuiltinReachabilityCorpus as parseCorpus,
  validateNodeBuiltinReachabilityInventory as validateInventory,
} from "./reachabilityEvidence.ts";
import type {
  BuiltinCallSite,
  BuiltinReachabilityMethod,
  NodeBuiltinReachabilityAssessment,
  NodeBuiltinReachabilityInventory,
} from "./reachabilityTypes.ts";
export type {
  BuiltinCallSite,
  BuiltinReachabilityCorpus,
  BuiltinReachabilityMethod,
  NodeBuiltinReachabilityAssessment,
  NodeBuiltinReachabilityInventory,
} from "./reachabilityTypes.ts";

export function createNodeBuiltinReachabilityInventory(
  report: NodeBuiltinCoverageReport,
  sources: readonly (NodeBuiltinSourceInventory & {
    readonly requiredFunctions: readonly NodeBuiltinFunctionCall[];
  })[],
  analysisSources: readonly (NodeBuiltinSourceInventory & {
    readonly requiredFunctions: readonly NodeBuiltinFunctionCall[];
  })[] = sources,
): NodeBuiltinReachabilityInventory {
  const sourceFiles = sources.map(({ name, bytes, sha256, sourceUtf16Length }) => ({
    name,
    bytes,
    sha256,
    sourceUtf16Length,
  }));
  const sourceByModule = new Map(sourceFiles.map((source) => [source.name, source]));
  const assessedBySite = new Map(
    report.requiredFunctions.flatMap((call) => (call.siteId ? [[call.siteId, call] as const] : [])),
  );
  const callSites: BuiltinCallSite[] = sources.flatMap((sourceInventory) =>
    sourceInventory.requiredFunctions.map((call) => {
      const source = sourceByModule.get(call.module);
      const assessed = call.siteId ? assessedBySite.get(call.siteId) : undefined;
      if (
        !source ||
        !call.siteId ||
        !assessed ||
        call.offsetUnit !== "utf16-code-units" ||
        !Number.isSafeInteger(call.startOffset) ||
        !Number.isSafeInteger(call.endOffset) ||
        call.startOffset! < 0 ||
        call.endOffset! <= call.startOffset! ||
        call.endOffset! > source.sourceUtf16Length
      )
        return invalid();
      return { ...assessed, sourceSha256: source.sha256 } as BuiltinCallSite;
    }),
  );
  const runtimeSiteIds = new Set(callSites.map((call) => call.siteId));
  const analysisSourceByName = new Map(analysisSources.map((source) => [source.name, source]));
  const analysisOnlyCallSites = report.requiredFunctions.flatMap((call) => {
    if (call.siteId && runtimeSiteIds.has(call.siteId)) return [];
    const source = analysisSourceByName.get(call.module);
    if (!source || !call.siteId) return invalid();
    return [{ ...call, sourceSha256: source.sha256 } as BuiltinCallSite];
  });
  return {
    schemaVersion: 1,
    sourceFiles,
    callSites,
    analysisOnlyCallSites,
    missingBuiltins: report.missingBuiltins,
    unknownBuiltinSpecifiers: report.unknownBuiltinSpecifiers,
    ambiguities: report.ambiguities,
    functionAmbiguities: report.functionAmbiguities,
  };
}

/** Recomputes release disposition from exact-source call sites and separately trusted V8 evidence. */
export function assessNodeBuiltinReachability(input: {
  readonly artifactSha256: string;
  readonly inventory: NodeBuiltinReachabilityInventory;
  readonly corpus?: unknown;
}): NodeBuiltinReachabilityAssessment {
  if (!hash(input.artifactSha256)) return invalid();
  const inventory = input.inventory;
  validateInventory(inventory);
  const corpus = input.corpus === undefined ? undefined : parseCorpus(input.corpus);
  const inheritance = deriveHarnessReleaseInheritedReachability(
    input.artifactSha256,
    inventory,
    corpus ?? { schemaVersion: 1, runs: [] },
  );
  if (!inheritance) return invalid();
  const inheritedBySite = new Map(
    inheritance.inheritedSites.map((site) => [site.siteId, site.inheritedFrom]),
  );
  const excludedRuns: { runId: string; reason: string }[] = [];
  const matchingRuns = (corpus?.runs ?? []).filter((run) => {
    if (run.artifactSha256 === input.artifactSha256) return true;
    if (run.kind === "a-series-replay" && run.captureState !== "not-started") return false;
    excludedRuns.push({
      runId: run.runId,
      reason:
        run.captureState === "not-started"
          ? "observation capture did not start; empty sites are not evidence of absence"
          : "foreign release qualification cannot qualify this candidate",
    });
    return false;
  });
  const sourceByModule = new Map(inventory.sourceFiles.map((source) => [source.name, source]));
  const siteById = new Map(inventory.callSites.map((site) => [site.siteId, site]));
  const reachedBySite = new Map<string, { runId: string; method: BuiltinReachabilityMethod }>();
  const qualificationRuns = matchingRuns.filter((run) => run.kind === "release-qualification");
  const qualifiedRun = qualificationRuns.length === 1 ? qualificationRuns[0] : undefined;
  let hasQualifiedRun = false;
  const blockers = [
    ...inventory.missingBuiltins.map((name) => `missing builtin module ${name}`),
    ...inventory.unknownBuiltinSpecifiers.map((name) => `unknown builtin specifier ${name}`),
    ...inventory.ambiguities.map(
      (site) => `unresolved import ${site.kind}@${site.module}:${site.line}:${site.column}`,
    ),
    ...inventory.functionAmbiguities.map(
      (site) => `unresolved call ${site.kind}@${site.module}:${site.line}:${site.column}`,
    ),
  ];
  if (qualificationRuns.length > 1)
    blockers.push("more than one release qualification run is pinned to this candidate");
  for (const run of qualificationRuns)
    if (!run.completed || run.captureState !== "complete")
      blockers.push(`release qualification workload or capture ${run.runId} did not complete`);
  for (const run of matchingRuns) {
    if (run.captureState === "not-started") {
      if (
        run.sources.some(
          (source) => source.executedByteRanges.length || source.invokedSiteIds.length,
        )
      )
        return invalid();
      excludedRuns.push({
        runId: run.runId,
        reason: "observation capture did not start; empty sites are not evidence of absence",
      });
      continue;
    }
    const moduleByName = new Map(run.sources.map((source) => [source.module, source]));
    if (
      run.sources.length !== inventory.sourceFiles.length ||
      inventory.sourceFiles.some(
        (source) => moduleByName.get(source.name)?.sourceSha256 !== source.sha256,
      )
    ) {
      excludedRuns.push({
        runId: run.runId,
        reason: "module source inventory does not match the scanned candidate",
      });
      if (run.kind === "release-qualification")
        blockers.push(
          `release qualification workload ${run.runId} source inventory does not match the candidate`,
        );
      continue;
    }
    const hasExecutionEvidence =
      inventory.sourceFiles.length === 0 ||
      run.sources.some(
        (source) => source.executedByteRanges.length > 0 || source.invokedSiteIds.length > 0,
      );
    if (run.kind === "release-qualification" && !hasExecutionEvidence)
      blockers.push(`release qualification capture ${run.runId} has no executed evidence`);
    if (
      run.kind === "release-qualification" &&
      run.completed &&
      run.captureState === "complete" &&
      run === qualifiedRun &&
      hasExecutionEvidence
    )
      hasQualifiedRun = true;
    for (const source of run.sources) {
      const pinned = sourceByModule.get(source.module)!;
      for (const range of source.executedByteRanges)
        if (range.endOffset > pinned.sourceUtf16Length) return invalid();
      for (const siteId of source.invokedSiteIds) {
        const site = siteById.get(siteId);
        if (!site || site.module !== source.module) return invalid();
        reachedBySite.set(siteId, { runId: run.runId, method: "observed invocation" });
      }
    }
    for (const site of inventory.callSites) {
      const source = moduleByName.get(site.module)!;
      const observed = reachedBySite.get(site.siteId);
      if (observed) continue;
      if (
        source.executedByteRanges.some(
          (range) => range.startOffset < site.endOffset! && range.endOffset > site.startOffset!,
        )
      )
        reachedBySite.set(site.siteId, { runId: run.runId, method: "reached by executed range" });
    }
  }
  const allSiteById = new Map(
    [...inventory.callSites, ...inventory.analysisOnlyCallSites].map((site) => [site.siteId, site]),
  );
  for (const [id, observations] of inheritedBySite) {
    const first = observations[0]!;
    if (!reachedBySite.has(id)) reachedBySite.set(id, { runId: first.runId, method: first.method });
  }
  const reachedSites = [...reachedBySite].flatMap(([siteId, reached]) => {
    const site = allSiteById.get(siteId)!;
    return [
      {
        siteId,
        module: site.module,
        specifier: site.specifier,
        memberPath: site.memberPath,
        status: site.status,
        method: reached.method,
        runId: reached.runId,
        ...(inheritedBySite.has(siteId) ? { inheritedFrom: inheritedBySite.get(siteId)! } : {}),
      },
    ];
  });
  const unmappedAnalysisSites = inventory.analysisOnlyCallSites
    .filter((site) => site.status !== "supported")
    .map((site) => ({
      siteId: site.siteId,
      module: site.module,
      specifier: site.specifier,
      memberPath: site.memberPath,
      status: site.status,
    }));
  for (const site of inventory.analysisOnlyCallSites) {
    if (inheritedBySite.has(site.siteId) && site.status !== "supported")
      blockers.push(
        `reached ${site.status} builtin ${site.specifier}.${site.memberPath.join(".") || "<default>"}@${site.module}:${site.line}:${site.column}`,
      );
  }
  const openObligations: NodeBuiltinReachabilityAssessment["openObligations"][number][] = [];
  for (const site of inventory.callSites) {
    const reached = reachedBySite.has(site.siteId);
    if (reached && site.status !== "supported") {
      blockers.push(
        `reached ${site.status} builtin ${site.specifier}.${site.memberPath.join(".") || "<default>"}@${site.module}:${site.line}:${site.column}`,
      );
      continue;
    }
    if (site.status === "unsupported" && isNamedRuntimeFailure(site.failure))
      openObligations.push({
        kind: "unsupported-fail-loud",
        siteId: site.siteId,
        module: site.module,
        specifier: site.specifier,
        memberPath: site.memberPath,
        failureCode: site.failure.code,
        state: !hasQualifiedRun ? "awaiting-coverage" : reached ? "awaiting-coverage" : "unreached",
      });
    else if (site.status === "guarded" && site.guard) {
      blockers.push(
        `missing guarded builtin ${site.specifier}.${site.memberPath.join(".") || "<default>"}@${site.module}:${site.line}:${site.column} has no fail-loud callable`,
      );
      openObligations.push({
        kind: "guarded-missing",
        siteId: site.siteId,
        module: site.module,
        specifier: site.specifier,
        memberPath: site.memberPath,
        guardExpression: site.guard.expression,
        state: "awaiting-named-error",
      });
    } else if (site.status === "guarded")
      blockers.push(
        `missing guarded builtin ${site.specifier}.${site.memberPath.join(".") || "<default>"}@${site.module}:${site.line}:${site.column} has no fail-loud callable`,
      );
    else if (site.status !== "supported" && site.status !== "platform-pruned")
      blockers.push(
        `unresolved ${site.status} builtin ${site.specifier}.${site.memberPath.join(".") || "<default>"}@${site.module}:${site.line}:${site.column}`,
      );
  }
  const coverageStatus =
    blockers.length > 0
      ? "rejected"
      : hasQualifiedRun && unmappedAnalysisSites.length === 0
        ? "passed"
        : "pending";
  return {
    schemaVersion: 1,
    artifactSha256: input.artifactSha256,
    evidence: { inventory, corpus: corpus ?? { schemaVersion: 1, runs: [] } },
    coverageStatus,
    observation: {
      method: "reached by executed range",
      limitation:
        "A V8 executed-range overlap records control-flow reachability only; it does not prove the builtin call succeeded or count invocations.",
    },
    ...(hasQualifiedRun && qualifiedRun ? { qualifiedRunId: qualifiedRun.runId } : {}),
    reachedSites,
    removedApiPaths: inheritance.removedApiPaths,
    unmappedAnalysisSites,
    blockers: [...new Set(blockers)].sort(),
    openObligations,
    excludedRuns,
  };
}
