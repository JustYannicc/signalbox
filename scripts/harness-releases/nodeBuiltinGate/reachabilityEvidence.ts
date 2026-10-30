import { isNamedRuntimeFailure } from "./coverage.ts";
import type {
  BuiltinReachabilityCorpus,
  BuiltinReachabilityRun,
  BuiltinReachabilitySource,
  NodeBuiltinReachabilityInventory,
} from "./reachabilityTypes.ts";
import type { NodeBuiltinSourceInventory } from "./coverage.ts";

export const isReachabilityHash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
export const isReachabilityRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);
export const invalidReachabilityEvidence = (): never => {
  throw new Error("NODE_BUILTIN_REACHABILITY_EVIDENCE_INVALID");
};

export function parseBuiltinReachabilityCorpus(value: unknown): BuiltinReachabilityCorpus {
  if (
    !isReachabilityRecord(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "runs",
      ...("inheritedArtifacts" in value ? ["inheritedArtifacts"] : []),
    ]) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.runs)
  )
    return invalidReachabilityEvidence();
  const runIds = new Set<string>();
  const runs = value.runs.map((raw): BuiltinReachabilityRun => {
    if (
      !isReachabilityRecord(raw) ||
      !exactKeys(raw, [
        "kind",
        "runId",
        "artifactSha256",
        "completed",
        "captureState",
        "evidenceSha256",
        "sources",
      ]) ||
      (raw.kind !== "a-series-replay" && raw.kind !== "release-qualification") ||
      typeof raw.runId !== "string" ||
      raw.runId.length === 0 ||
      runIds.has(raw.runId) ||
      !isReachabilityHash(raw.artifactSha256) ||
      typeof raw.completed !== "boolean" ||
      (raw.captureState !== "complete" &&
        raw.captureState !== "incomplete" &&
        raw.captureState !== "not-started") ||
      !isReachabilityHash(raw.evidenceSha256) ||
      !Array.isArray(raw.sources)
    )
      return invalidReachabilityEvidence();
    runIds.add(raw.runId);
    const moduleNames = new Set<string>();
    const sources = raw.sources.map((item): BuiltinReachabilitySource => {
      if (
        !isReachabilityRecord(item) ||
        !exactKeys(item, ["module", "sourceSha256", "executedByteRanges", "invokedSiteIds"]) ||
        typeof item.module !== "string" ||
        item.module.length === 0 ||
        moduleNames.has(item.module) ||
        !isReachabilityHash(item.sourceSha256) ||
        !Array.isArray(item.executedByteRanges) ||
        !Array.isArray(item.invokedSiteIds)
      )
        return invalidReachabilityEvidence();
      moduleNames.add(item.module);
      const executedByteRanges = item.executedByteRanges.map((range) => {
        if (
          !isReachabilityRecord(range) ||
          !exactKeys(range, ["startOffset", "endOffset", "offsetUnit", "executionCount"]) ||
          !Number.isSafeInteger(range.startOffset) ||
          !Number.isSafeInteger(range.endOffset) ||
          (range.startOffset as number) < 0 ||
          (range.endOffset as number) <= (range.startOffset as number) ||
          range.offsetUnit !== "utf16-code-units" ||
          !Number.isSafeInteger(range.executionCount) ||
          (range.executionCount as number) <= 0
        )
          return invalidReachabilityEvidence();
        return {
          startOffset: range.startOffset as number,
          endOffset: range.endOffset as number,
          offsetUnit: "utf16-code-units" as const,
          executionCount: range.executionCount as number,
        };
      });
      const invokedSiteIds = item.invokedSiteIds.map((siteId) => {
        if (!isReachabilityHash(siteId)) return invalidReachabilityEvidence();
        return siteId;
      });
      if (new Set(invokedSiteIds).size !== invokedSiteIds.length)
        return invalidReachabilityEvidence();
      return {
        module: item.module,
        sourceSha256: item.sourceSha256,
        executedByteRanges,
        invokedSiteIds,
      };
    });
    return {
      kind: raw.kind,
      runId: raw.runId,
      artifactSha256: raw.artifactSha256,
      completed: raw.completed,
      captureState: raw.captureState,
      evidenceSha256: raw.evidenceSha256,
      sources,
    };
  });
  const inheritedArtifacts = value.inheritedArtifacts;
  if (inheritedArtifacts === undefined) return { schemaVersion: 1, runs };
  if (!Array.isArray(inheritedArtifacts)) return invalidReachabilityEvidence();
  const artifacts = new Set<string>();
  const history = inheritedArtifacts.map((entry) => {
    if (
      !isReachabilityRecord(entry) ||
      !exactKeys(entry, ["release", "artifactSha256", "inventory"]) ||
      typeof entry.release !== "string" ||
      !entry.release ||
      !isReachabilityHash(entry.artifactSha256) ||
      artifacts.has(entry.artifactSha256)
    )
      return invalidReachabilityEvidence();
    artifacts.add(entry.artifactSha256);
    const inventory = entry.inventory as NodeBuiltinReachabilityInventory;
    validateNodeBuiltinReachabilityInventory(inventory);
    return { release: entry.release, artifactSha256: entry.artifactSha256, inventory };
  });
  return { schemaVersion: 1, runs, inheritedArtifacts: history };
}

export function validateNodeBuiltinReachabilityInventory(
  value: NodeBuiltinReachabilityInventory,
): void {
  if (
    !isReachabilityRecord(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "sourceFiles",
      "callSites",
      "analysisOnlyCallSites",
      "missingBuiltins",
      "unknownBuiltinSpecifiers",
      "ambiguities",
      "functionAmbiguities",
    ]) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.sourceFiles) ||
    !Array.isArray(value.callSites) ||
    !Array.isArray(value.analysisOnlyCallSites) ||
    !Array.isArray(value.missingBuiltins) ||
    !Array.isArray(value.unknownBuiltinSpecifiers) ||
    !Array.isArray(value.ambiguities) ||
    !Array.isArray(value.functionAmbiguities)
  )
    return invalidReachabilityEvidence();
  if (
    !value.missingBuiltins.every((name: unknown) => typeof name === "string" && name.length > 0) ||
    !value.unknownBuiltinSpecifiers.every(
      (name: unknown) => typeof name === "string" && name.length > 0,
    )
  )
    return invalidReachabilityEvidence();
  const sourceByModule = new Map<string, NodeBuiltinSourceInventory>();
  for (const source of value.sourceFiles) {
    if (
      !isReachabilityRecord(source) ||
      !exactKeys(source, ["name", "bytes", "sha256", "sourceUtf16Length"]) ||
      typeof source.name !== "string" ||
      !source.name ||
      !isReachabilityHash(source.sha256) ||
      !Number.isSafeInteger(source.bytes) ||
      (source.bytes as number) < 0 ||
      !Number.isSafeInteger(source.sourceUtf16Length) ||
      (source.sourceUtf16Length as number) < 0 ||
      sourceByModule.has(source.name)
    )
      return invalidReachabilityEvidence();
    sourceByModule.set(source.name, source as unknown as NodeBuiltinSourceInventory);
  }
  const siteIds = new Set<string>();
  for (const call of value.callSites) {
    const keys = [
      "siteId",
      "sourceSha256",
      "module",
      "startOffset",
      "endOffset",
      "offsetUnit",
      "line",
      "column",
      "specifier",
      "memberPath",
      "status",
      "evidence",
      ...(isReachabilityRecord(call) && "guard" in call ? ["guard"] : []),
      ...(isReachabilityRecord(call) && "failure" in call ? ["failure"] : []),
    ];
    if (!isReachabilityRecord(call) || !exactKeys(call, keys) || typeof call.module !== "string")
      return invalidReachabilityEvidence();
    const source = sourceByModule.get(call.module);
    if (
      !source ||
      source.sha256 !== call.sourceSha256 ||
      !isReachabilityHash(call.siteId) ||
      siteIds.has(call.siteId) ||
      call.offsetUnit !== "utf16-code-units" ||
      !Number.isSafeInteger(call.startOffset) ||
      !Number.isSafeInteger(call.endOffset) ||
      (call.startOffset as number) < 0 ||
      (call.endOffset as number) <= (call.startOffset as number) ||
      (call.endOffset as number) > source.sourceUtf16Length ||
      typeof call.specifier !== "string" ||
      !call.specifier ||
      !Array.isArray(call.memberPath) ||
      !call.memberPath.every((part: unknown) => typeof part === "string" && part.length > 0)
    )
      return invalidReachabilityEvidence();
    if (
      !Number.isSafeInteger(call.line) ||
      (call.line as number) <= 0 ||
      !Number.isSafeInteger(call.column) ||
      (call.column as number) <= 0 ||
      typeof call.evidence !== "string" ||
      call.evidence.length === 0 ||
      ![
        "supported",
        "unsupported",
        "missing",
        "platform-pruned",
        "conditional",
        "unknown",
        "guarded",
      ].includes(call.status as string)
    )
      return invalidReachabilityEvidence();
    if (call.status === "unsupported" && !isNamedRuntimeFailure(call.failure))
      return invalidReachabilityEvidence();
    if (call.guard !== undefined) {
      if (
        !isReachabilityRecord(call.guard) ||
        !exactKeys(call.guard, ["kind", "expression", "line", "column"]) ||
        !["feature-test", "optional-call", "caught-call"].includes(call.guard.kind as string) ||
        typeof call.guard.expression !== "string" ||
        !call.guard.expression ||
        !Number.isSafeInteger(call.guard.line) ||
        !Number.isSafeInteger(call.guard.column)
      )
        return invalidReachabilityEvidence();
    }
    if (
      call.failure !== undefined &&
      (call.status !== "unsupported" || !isNamedRuntimeFailure(call.failure))
    )
      return invalidReachabilityEvidence();
    siteIds.add(call.siteId);
  }
  for (const call of value.analysisOnlyCallSites) {
    const keys = [
      "siteId",
      "sourceSha256",
      "module",
      "startOffset",
      "endOffset",
      "offsetUnit",
      "line",
      "column",
      "specifier",
      "memberPath",
      "status",
      "evidence",
      ...(isReachabilityRecord(call) && "guard" in call ? ["guard"] : []),
      ...(isReachabilityRecord(call) && "failure" in call ? ["failure"] : []),
    ];
    if (
      !isReachabilityRecord(call) ||
      !exactKeys(call, keys) ||
      !isReachabilityHash(call.siteId) ||
      siteIds.has(call.siteId) ||
      !isReachabilityHash(call.sourceSha256) ||
      typeof call.module !== "string" ||
      !call.module ||
      call.offsetUnit !== "utf16-code-units" ||
      !Number.isSafeInteger(call.startOffset) ||
      !Number.isSafeInteger(call.endOffset) ||
      (call.startOffset as number) < 0 ||
      (call.endOffset as number) <= (call.startOffset as number) ||
      !Number.isSafeInteger(call.line) ||
      (call.line as number) <= 0 ||
      !Number.isSafeInteger(call.column) ||
      (call.column as number) <= 0 ||
      typeof call.specifier !== "string" ||
      !call.specifier ||
      !Array.isArray(call.memberPath) ||
      !call.memberPath.every((part: unknown) => typeof part === "string" && part.length > 0) ||
      ![
        "supported",
        "unsupported",
        "missing",
        "platform-pruned",
        "conditional",
        "unknown",
        "guarded",
      ].includes(call.status as string) ||
      typeof call.evidence !== "string" ||
      !call.evidence
    )
      return invalidReachabilityEvidence();
    if (call.status === "unsupported" && !isNamedRuntimeFailure(call.failure))
      return invalidReachabilityEvidence();
    if (
      call.failure !== undefined &&
      (call.status !== "unsupported" || !isNamedRuntimeFailure(call.failure))
    )
      return invalidReachabilityEvidence();
    siteIds.add(call.siteId);
  }
}
