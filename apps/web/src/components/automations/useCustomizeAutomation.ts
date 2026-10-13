import type { Automation, EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { automationState } from "../../state/automations";
import { automationRoute } from "./automationFormat";
import { useAutomationCommand } from "./useAutomationCommand";

/**
 * A built-in's code is Signalbox's. Customize saves an editable copy into the
 * built-in's project, which runs it from then on, and opens the copy.
 */
export function useCustomizeAutomation(
  environmentId: EnvironmentId,
  automation: Pick<Automation, "id" | "projectId">,
) {
  const navigate = useNavigate();
  const { run, busy } = useAutomationCommand(automationState.customize, "Couldn't customize it");
  const customize = async () => {
    const result = await run({
      environmentId,
      input: { automationId: automation.id, projectId: automation.projectId },
    });
    if (result) void navigate(automationRoute({ environmentId, automationId: result.value.id }));
  };
  return { customize, busy };
}
