/**
 * Per-iteration history of a review loop run: what each pass found, so a
 * shipped change shows how it got there.
 */
import { formatDuration } from "@t3tools/shared/orchestrationTiming";

import type { RunIteration } from "./automationModel";

function findingsLabel(iteration: RunIteration) {
  if (iteration.status === "running") return "Reviewing";
  if (iteration.findings === 0) return "Pass";
  return iteration.findings === 1 ? "1 finding" : `${iteration.findings} findings`;
}

export function RunIterations(props: {
  iterations: readonly RunIteration[];
  maxIterations: number | null;
}) {
  return (
    <ol className="flex flex-col gap-2.5" aria-label="Review iterations">
      {props.iterations.map((iteration, index) => (
        // Iterations are append-only; the index is the iteration number.
        // eslint-disable-next-line react/no-array-index-key
        <li key={index} className="flex">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex items-baseline justify-between gap-2 text-xs">
              <span className="font-medium text-foreground">
                Iteration {index + 1}
                {props.maxIterations ? ` / ${props.maxIterations}` : ""} ·{" "}
                {findingsLabel(iteration)}
              </span>
              {iteration.durationMs !== undefined ? (
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  {formatDuration(iteration.durationMs)}
                </span>
              ) : null}
            </span>
            <span className="text-sm text-pretty text-muted-foreground">{iteration.summary}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}
