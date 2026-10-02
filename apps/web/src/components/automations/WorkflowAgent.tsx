/**
 * Every automation has an unnamed supervisor agent responsible for it, with a
 * generated avatar. It is the one way to change a workflow: talk to it.
 */
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { SupervisorAvatar } from "../assistant/AssistantGlyphs";
import { workflowAgentId, type Automation } from "./automationModel";
import { automationDisplayStatus } from "./automationStatus";
import { RunStatusMarker } from "./RunStatusMarker";

export function WorkflowAgentAvatar(props: {
  automation: Automation;
  size: number;
  className?: string;
}) {
  return (
    <SupervisorAvatar
      agentId={workflowAgentId(props.automation)}
      size={props.size}
      className={props.className}
    />
  );
}

/** Opens the automation's workflow agent, optionally with a prompt prefilled. */
export function useOpenWorkflowAgent() {
  const navigate = useNavigate();
  return useCallback(
    (automation: Automation, prompt?: string) =>
      void navigate({
        to: "/agent/$agentId",
        params: { agentId: workflowAgentId(automation) },
        search: prompt ? { prompt } : {},
      }),
    [navigate],
  );
}

/** Header control: the agent's face and name, plus the automation's most urgent status. */
export function WorkflowAgentButton(props: { automation: Automation }) {
  const openAgent = useOpenWorkflowAgent();
  const { automation } = props;
  return (
    <span className="flex min-w-0 shrink items-center gap-2">
      <button
        type="button"
        onClick={() => openAgent(automation)}
        aria-label={`Talk to ${automation.agentName}`}
        className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md py-0.5 pr-1.5 pl-0.5 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <WorkflowAgentAvatar automation={automation} size={20} />
        <span className="hidden truncate lg:block">{automation.agentName}</span>
      </button>
      <RunStatusMarker status={automationDisplayStatus(automation)} />
    </span>
  );
}
