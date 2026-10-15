/**
 * Thread details: what the thread is waiting on. Each row is an automation run
 * attached to the thread (an agent's `wait_for`, a pull request watch), which
 * is what keeps the thread in Working. A row opens its run, so anyone can see
 * exactly what it's waiting for; the square stops it. Renders nothing while
 * the thread waits on nothing.
 */
import { attachedRunOf } from "@t3tools/client-runtime/automations/attached";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { HourglassIcon, SquareIcon } from "lucide-react";
import { useState } from "react";

import { useThreadShell } from "../../state/entities";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { ThreadDetailsSection } from "../chat/ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "../chat/threadDetailsPanelStyles";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { automationState } from "../../state/automations";
import { automationRoute } from "./automationFormat";
import { useAutomationCommand } from "./useAutomationCommand";

export function ThreadWaitsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const shell = useThreadShell({ environmentId: props.environmentId, threadId: props.threadId });
  const navigate = useNavigate();
  const stop = useAutomationCommand(automationState.cancelRun, "Couldn't stop waiting");
  // The shell drops a stopped run only on the thread's next event; it's gone already.
  const [stopped, setStopped] = useState<ReadonlySet<string>>(new Set());
  const waits = (shell?.pendingBackgroundTasks ?? []).flatMap((task) => {
    const run = attachedRunOf(task.taskId);
    return run && !stopped.has(run.runId)
      ? [{ ...run, label: task.description ?? "Automation running" }]
      : [];
  });
  if (waits.length === 0) return null;

  return (
    <ThreadDetailsSection headingId="thread-details-waits-heading" title="Waiting on">
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {waits.map((wait) => (
          <li key={wait.runId} className={THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS}>
            <ThreadDetailsControl
              size="sm"
              variant="ghost"
              part="primary"
              aria-label={`Open ${wait.label}`}
              onClick={() =>
                void navigate(
                  automationRoute(
                    { environmentId: props.environmentId, automationId: wait.automationId },
                    wait.runId,
                  ),
                )
              }
            >
              <HourglassIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
              {/* Under "Waiting on", an agent's "Waiting for …" reads as just the thing. */}
              <span className={`min-w-0 flex-1 truncate ${THREAD_DETAILS_PANEL_LABEL_CLASS}`}>
                {wait.label.replace(/^Waiting for /, "")}
              </span>
            </ThreadDetailsControl>
            <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
            <Tooltip>
              <TooltipTrigger
                render={
                  <ThreadDetailsControl
                    size="sm"
                    variant="ghost"
                    part="secondary"
                    aria-label={`Stop: ${wait.label}`}
                    disabled={stop.busy}
                    onClick={async () => {
                      const done = await stop.run({
                        environmentId: props.environmentId,
                        input: { runId: wait.runId },
                      });
                      if (done) setStopped((current) => new Set(current).add(wait.runId));
                    }}
                  >
                    <SquareIcon className="size-3" />
                  </ThreadDetailsControl>
                }
              />
              <TooltipPopup side="left">Stop waiting</TooltipPopup>
            </Tooltip>
          </li>
        ))}
      </ul>
    </ThreadDetailsSection>
  );
}
