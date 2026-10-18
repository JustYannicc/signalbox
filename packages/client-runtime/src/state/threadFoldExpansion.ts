import type { OrchestrationV2RunStatus, RunId } from "@t3tools/contracts";

type RunContinuationLookup = ReadonlyMap<RunId, { readonly rootRunId: RunId }> | undefined;

type RunFoldSnapshot = {
  readonly runId: RunId;
  readonly status: OrchestrationV2RunStatus;
};

const logicalRunId = (runId: RunId, continuations: RunContinuationLookup): RunId =>
  continuations?.get(runId)?.rootRunId ?? runId;

const canonicalExpandedRunIds = (
  expandedRunIds: ReadonlySet<RunId>,
  continuations: RunContinuationLookup,
): Set<RunId> => new Set([...expandedRunIds].map((runId) => logicalRunId(runId, continuations)));

function setRunFoldExpanded(
  expandedRunIds: ReadonlySet<RunId>,
  runId: RunId,
  expanded: boolean,
  continuations: RunContinuationLookup,
): ReadonlySet<RunId> {
  const next = canonicalExpandedRunIds(expandedRunIds, continuations);
  const logicalId = logicalRunId(runId, continuations);
  if (expanded) next.add(logicalId);
  else next.delete(logicalId);
  return next;
}

export function toggleRunFoldExpansion(
  expandedRunIds: ReadonlySet<RunId>,
  runId: RunId,
  continuations: RunContinuationLookup,
): ReadonlySet<RunId> {
  const next = canonicalExpandedRunIds(expandedRunIds, continuations);
  const logicalId = logicalRunId(runId, continuations);
  if (!next.delete(logicalId)) next.add(logicalId);
  return next;
}

export function transitionRunFoldExpansion(
  expandedRunIds: ReadonlySet<RunId>,
  previous: RunFoldSnapshot | null | undefined,
  latest: RunFoldSnapshot | null | undefined,
  continuations: RunContinuationLookup,
): ReadonlySet<RunId> {
  if (!previous || !latest) return expandedRunIds;
  if (latest.runId === previous.runId) {
    return previous.status === "running" && latest.status === "interrupted"
      ? setRunFoldExpanded(expandedRunIds, latest.runId, true, continuations)
      : expandedRunIds;
  }

  const previousLogicalId = logicalRunId(previous.runId, continuations);
  if (
    ![...expandedRunIds].some((runId) => logicalRunId(runId, continuations) === previousLogicalId)
  ) {
    return expandedRunIds;
  }
  return setRunFoldExpanded(expandedRunIds, previous.runId, false, continuations);
}
