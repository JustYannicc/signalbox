import { canRetryRun } from "@t3tools/client-runtime/automations/list";
import type { AutomationRunSummary, EnvironmentId } from "@t3tools/contracts";

import { useRetryRun, useStopRun } from "./automation-hooks";
import { PillButton } from "./AutomationParts";

interface RunStateAction {
  readonly label: string;
  readonly tone: "primary" | "secondary";
  readonly disabled: boolean;
  readonly onPress: () => void;
}

/** The one action a run's state calls for: answer its question, stop it, or retry it. */
export function useRunStateAction(
  environmentId: EnvironmentId,
  run: AutomationRunSummary,
  latestVersion: number | null,
  onAnswer?: () => void,
): RunStateAction | null {
  const { stopping, stop } = useStopRun(environmentId, run.id);
  const { retrying, retry } = useRetryRun(environmentId);
  if (onAnswer) return { label: "Answer", tone: "primary", disabled: false, onPress: onAnswer };
  if (run.status === "running") {
    return {
      label: stopping ? "Stopping…" : "Stop",
      tone: "secondary",
      disabled: stopping,
      onPress: stop,
    };
  }
  if (canRetryRun(run)) {
    return {
      label: retrying ? "Retrying…" : "Retry",
      tone: "secondary",
      disabled: retrying,
      onPress: () => retry(run, latestVersion),
    };
  }
  return null;
}

/** The run state action as a pill, for the chat header and the diagram's run bar. */
export function RunStateButton(props: {
  readonly environmentId: EnvironmentId;
  readonly run: AutomationRunSummary;
  readonly latestVersion: number | null;
  readonly onAnswer?: () => void;
}) {
  const action = useRunStateAction(
    props.environmentId,
    props.run,
    props.latestVersion,
    props.onAnswer,
  );
  return action ? (
    <PillButton
      label={action.label}
      tone={action.tone}
      disabled={action.disabled}
      onPress={action.onPress}
    />
  ) : null;
}
