import type { OrchestrationV2Run } from "@t3tools/contracts";

export type RunContinuationLink = Pick<
  OrchestrationV2Run,
  "id" | "ordinal" | "restartContinuationOfRunId"
>;

/** A run followed by each continuation that directly resumes it. */
export const runContinuationChain = <Run extends RunContinuationLink>(
  runs: ReadonlyArray<Run>,
  runOrId: Run | string | null | undefined,
): ReadonlyArray<Run> => {
  const runId = typeof runOrId === "string" ? runOrId : runOrId?.id;
  const original = runs.find((run) => run.id === runId);
  if (original === undefined) return [];

  const chain = [original];
  const seen = new Set([original.id]);
  let current = original;
  while (true) {
    const next = runs
      .filter(
        (candidate) =>
          candidate.restartContinuationOfRunId === current.id && !seen.has(candidate.id),
      )
      .toSorted((left, right) => left.ordinal - right.ordinal)[0];
    if (next === undefined) return chain;
    chain.push(next);
    seen.add(next.id);
    current = next;
  }
};

/** The first run whose work a recovery continuation carries forward. */
export const runOrigin = <Run extends RunContinuationLink>(
  runs: ReadonlyArray<Run>,
  runOrId: Run | string | null | undefined,
): Run | undefined => {
  const runId = typeof runOrId === "string" ? runOrId : runOrId?.id;
  const found = runs.find((run) => run.id === runId);
  if (found === undefined) return undefined;
  let current: Run = found;

  const seen = new Set([current.id]);
  while (true) {
    const previousId = current.restartContinuationOfRunId;
    if (previousId === undefined) return current;
    const previous: Run | undefined = runs.find((run) => run.id === previousId);
    if (previous === undefined || seen.has(previous.id)) return current;
    current = previous;
    seen.add(current.id);
  }
};

/** The tail of the latest root run, ignoring continuations of older roots. */
export const latestLogicalRun = <Run extends RunContinuationLink>(
  runs: ReadonlyArray<Run>,
): Run | undefined => {
  const root = runs
    .filter((run) => run.restartContinuationOfRunId === undefined)
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
  return runContinuationChain(runs, root).at(-1);
};
