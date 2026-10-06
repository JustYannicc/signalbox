/**
 * What a run can do from wherever it shows: a running run can be cancelled,
 * and a failed or cancelled one retried as a new run that reuses the steps
 * that went well, then opened. When the automation has a newer live version
 * than the run used, Retry offers that version too: the "I fixed the code"
 * case.
 */
import type {
  AutomationRetryVersion,
  AutomationRunSummary,
  EnvironmentId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, RotateCcwIcon, SquareIcon } from "lucide-react";

import { automationState } from "../../state/automations";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { automationRoute, type AutomationView } from "./automationFormat";
import { useAutomationCommand } from "./useAutomationCommand";

export function CancelRunButton(props: { environmentId: EnvironmentId; runId: string }) {
  const cancel = useAutomationCommand(automationState.cancelRun, "Couldn't cancel the run");
  return (
    <Button
      size="xs"
      variant="ghost-destructive"
      disabled={cancel.busy}
      onClick={() =>
        void cancel.run({ environmentId: props.environmentId, input: { runId: props.runId } })
      }
    >
      <SquareIcon />
      Cancel
    </Button>
  );
}

export function RetryRunButton(props: {
  environmentId: EnvironmentId;
  run: AutomationRunSummary;
  /** The automation's live version; newer than the run's offers retrying on it. */
  latestVersion: number;
  /** Which view the new run opens in. */
  view?: AutomationView;
}) {
  const { environmentId, run } = props;
  const navigate = useNavigate();
  const retryRun = useAutomationCommand(automationState.retryRun, "Couldn't retry the run");
  const newer = props.latestVersion > run.version;

  const retry = async (version: AutomationRetryVersion) => {
    const result = await retryRun.run({ environmentId, input: { runId: run.id, version } });
    if (!result) return;
    void navigate(
      automationRoute(
        { environmentId, automationId: run.automationId },
        result.value.id,
        props.view ?? "run",
      ),
    );
  };

  if (!newer) {
    return (
      <Button
        size="xs"
        variant="outline"
        disabled={retryRun.busy}
        onClick={() => void retry("same")}
      >
        <RotateCcwIcon />
        Retry
      </Button>
    );
  }
  return (
    <Menu>
      <MenuTrigger render={<Button size="xs" variant="outline" disabled={retryRun.busy} />}>
        <RotateCcwIcon />
        Retry
        <ChevronDownIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={() => void retry("latest")}>
          {`On the latest version (${props.latestVersion})`}
        </MenuItem>
        <MenuItem onClick={() => void retry("same")}>
          {`On this run's version (${run.version})`}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
