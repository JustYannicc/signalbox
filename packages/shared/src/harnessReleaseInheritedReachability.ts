export interface InheritedBuiltinObservation {
  readonly release: string;
  readonly runId: string;
  readonly artifactSha256: string;
  readonly evidenceSha256: string;
  readonly module: string;
  readonly sourceSha256: string;
  readonly siteId: string;
  readonly method: "observed invocation" | "reached by executed range";
  readonly label: string;
}

/** Historical replay ranges belong to their original source, then transfer by canonical API path. */
export function deriveHarnessReleaseInheritedReachability(
  artifactSha256: string,
  inventory: unknown,
  corpus: unknown,
):
  | {
      inheritedSites: { siteId: string; inheritedFrom: InheritedBuiltinObservation[] }[];
      removedApiPaths: {
        specifier: string;
        memberPath: string[];
        inheritedFrom: InheritedBuiltinObservation[];
      }[];
    }
  | undefined {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const rows = (value: unknown) => {
    if (!Array.isArray(value)) return undefined;
    const result = value.map(record);
    return result.every((row) => row !== undefined) ? result : undefined;
  };
  const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
  const hash = (value: unknown): value is string =>
    typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
  const natural = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const apiPath = (site: Record<string, unknown>) => {
    if (!text(site.specifier) || !Array.isArray(site.memberPath) || !site.memberPath.every(text))
      return undefined;
    const specifier = site.specifier.replace(/^node:/u, "");
    return {
      key: JSON.stringify([specifier, site.memberPath]),
      specifier,
      memberPath: site.memberPath,
    };
  };
  const current = record(inventory);
  const captures = record(corpus);
  const currentCalls = rows(current?.callSites);
  const analysisCalls = rows(current?.analysisOnlyCallSites);
  const runs = rows(captures?.runs);
  const historical =
    captures?.inheritedArtifacts === undefined ? [] : rows(captures.inheritedArtifacts);
  if (!hash(artifactSha256) || !currentCalls || !analysisCalls || !runs || !historical)
    return undefined;
  const currentByPath = new Map<string, string[]>();
  for (const site of [...currentCalls, ...analysisCalls]) {
    const path = apiPath(site);
    if (!path || !hash(site.siteId)) return undefined;
    const ids = currentByPath.get(path.key) ?? [];
    ids.push(site.siteId);
    currentByPath.set(path.key, ids);
  }
  const historyByArtifact = new Map<string, Record<string, unknown>>();
  for (const entry of historical) {
    if (
      !hash(entry.artifactSha256) ||
      entry.artifactSha256 === artifactSha256 ||
      historyByArtifact.has(entry.artifactSha256) ||
      !text(entry.release) ||
      !record(entry.inventory)
    )
      return undefined;
    historyByArtifact.set(entry.artifactSha256, entry);
  }
  const inherited = new Map<string, InheritedBuiltinObservation[]>();
  const removed = new Map<
    string,
    { specifier: string; memberPath: string[]; inheritedFrom: InheritedBuiltinObservation[] }
  >();
  for (const run of runs) {
    if (run.artifactSha256 === artifactSha256 || run.kind !== "a-series-replay") continue;
    if (!hash(run.artifactSha256) || !hash(run.evidenceSha256) || !text(run.runId))
      return undefined;
    const sources = rows(run.sources);
    if (!sources) return undefined;
    if (run.captureState === "not-started") {
      if (
        sources.some(
          (source) =>
            !Array.isArray(source.executedByteRanges) ||
            !Array.isArray(source.invokedSiteIds) ||
            source.executedByteRanges.length ||
            source.invokedSiteIds.length,
        )
      )
        return undefined;
      continue;
    }
    if (run.captureState !== "complete" && run.captureState !== "incomplete") return undefined;
    const entry = historyByArtifact.get(run.artifactSha256);
    const original = record(entry?.inventory);
    const originalSources = rows(original?.sourceFiles);
    const originalCalls = rows(original?.callSites);
    if (!entry || !original || original.schemaVersion !== 1 || !originalSources || !originalCalls)
      return undefined;
    const pinnedByName = new Map<string, Record<string, unknown>>();
    for (const source of originalSources) {
      if (
        !text(source.name) ||
        !hash(source.sha256) ||
        !natural(source.bytes) ||
        !natural(source.sourceUtf16Length) ||
        pinnedByName.has(source.name)
      )
        return undefined;
      pinnedByName.set(source.name, source);
    }
    const callById = new Map<string, Record<string, unknown>>();
    for (const call of originalCalls) {
      const pinned = text(call.module) ? pinnedByName.get(call.module) : undefined;
      if (
        !pinned ||
        !hash(call.siteId) ||
        callById.has(call.siteId) ||
        !apiPath(call) ||
        call.sourceSha256 !== pinned.sha256 ||
        call.offsetUnit !== "utf16-code-units" ||
        !natural(call.startOffset) ||
        !natural(call.endOffset) ||
        call.startOffset >= call.endOffset ||
        call.endOffset > Number(pinned.sourceUtf16Length)
      )
        return undefined;
      callById.set(call.siteId, call);
    }
    if (sources.length !== originalSources.length) return undefined;
    const names = new Set<string>();
    for (const source of sources) {
      const pinned = text(source.module) ? pinnedByName.get(source.module) : undefined;
      const ranges = rows(source.executedByteRanges);
      const invocations = source.invokedSiteIds;
      if (
        !pinned ||
        !text(source.module) ||
        names.has(source.module) ||
        source.sourceSha256 !== pinned.sha256 ||
        !ranges ||
        !Array.isArray(invocations) ||
        !invocations.every(hash) ||
        new Set(invocations).size !== invocations.length
      )
        return undefined;
      names.add(source.module);
      for (const range of ranges) {
        if (
          !natural(range.startOffset) ||
          !natural(range.endOffset) ||
          range.startOffset >= range.endOffset ||
          range.endOffset > Number(pinned.sourceUtf16Length) ||
          range.offsetUnit !== "utf16-code-units" ||
          !natural(range.executionCount) ||
          range.executionCount === 0
        )
          return undefined;
      }
      for (const id of invocations)
        if (callById.get(id)?.module !== source.module) return undefined;
      for (const [id, call] of callById) {
        if (call.module !== source.module) continue;
        const invoked = invocations.includes(id);
        if (
          !invoked &&
          !ranges.some(
            (range) =>
              Number(range.startOffset) < Number(call.endOffset) &&
              Number(range.endOffset) > Number(call.startOffset),
          )
        )
          continue;
        const path = apiPath(call)!;
        const observation: InheritedBuiltinObservation = {
          release: String(entry.release),
          runId: run.runId,
          artifactSha256: run.artifactSha256,
          evidenceSha256: run.evidenceSha256,
          module: source.module,
          sourceSha256: String(pinned.sha256),
          siteId: id,
          method: invoked ? "observed invocation" : "reached by executed range",
          label: `reached (inherited from ${String(entry.release)}/${run.runId})`,
        };
        const targetIds = currentByPath.get(path.key);
        if (targetIds) {
          for (const targetId of targetIds) {
            const observations = inherited.get(targetId) ?? [];
            observations.push(observation);
            inherited.set(targetId, observations);
          }
        } else {
          const disappearance = removed.get(path.key) ?? {
            specifier: path.specifier,
            memberPath: path.memberPath,
            inheritedFrom: [],
          };
          disappearance.inheritedFrom.push(observation);
          removed.set(path.key, disappearance);
        }
      }
    }
  }
  return {
    inheritedSites: [...inherited].map(([siteId, inheritedFrom]) => ({ siteId, inheritedFrom })),
    removedApiPaths: [...removed.values()],
  };
}
