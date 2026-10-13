/**
 * Who you talk to about an automation: the agent of the level it lives in
 * (`useAutomationLevel`), not an agent of its own. That agent is responsible
 * for the automations, tasks and threads at its level. Wrap the automation
 * page in `AutomationAgentProvider` once; the header button and every "Change
 * with agent" entry point open that agent with the automation as context (a
 * prefilled prompt). At the top level it is the assistant.
 */
import { useNavigate } from "@tanstack/react-router";
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";

import { SupervisorAvatar } from "../assistant/AssistantGlyphs";
import { AssistantIcon } from "../assistant/assistantIdentity";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { AutomationLevel } from "./automationHome";
import type { Automation } from "./automationModel";
import { automationDisplayStatus } from "./automationStatus";
import { RunStatusMarker } from "./RunStatusMarker";

interface AutomationAgent {
  readonly level: AutomationLevel;
  /** Opens the level's agent; the prompt defaults to "About the … automation: ". */
  readonly open: (prompt?: string) => void;
}

const AutomationAgentContext = createContext<AutomationAgent | null>(null);

export function AutomationAgentProvider(props: {
  automation: Automation;
  level: AutomationLevel;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const { automation, level } = props;
  const open = useCallback(
    (prompt = `About the “${automation.name}” automation: `) => {
      if (level.agentId === null) {
        void navigate({ to: "/assistant", search: { prompt } });
        return;
      }
      void navigate({
        to: "/agent/$agentId",
        params: { agentId: level.agentId },
        search: { prompt },
      });
    },
    [automation.name, level.agentId, navigate],
  );
  const value = useMemo(() => ({ level, open }), [level, open]);
  return <AutomationAgentContext value={value}>{props.children}</AutomationAgentContext>;
}

function useAutomationAgent(): AutomationAgent {
  const agent = useContext(AutomationAgentContext);
  if (!agent) throw new Error("useAutomationAgent needs an AutomationAgentProvider");
  return agent;
}

/** Opens the responsible level agent, optionally with a prompt prefilled. */
export function useOpenAutomationAgent() {
  return useAutomationAgent().open;
}

/** Header control: the level agent's face and name, plus the automation's most urgent status. */
export function AutomationAgentButton(props: { automation: Automation }) {
  const { level, open } = useAutomationAgent();
  const label = `Talk to ${level.agentName} about this automation`;
  return (
    <span className="flex min-w-0 shrink items-center gap-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={() => open()}
              aria-label={label}
              className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md py-0.5 pr-1.5 pl-0.5 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            />
          }
        >
          {level.agentId === null ? (
            <AssistantIcon size={20} />
          ) : (
            <SupervisorAvatar agentId={level.agentId} size={20} />
          )}
          <span className="hidden truncate lg:block">Talk to {level.agentName}</span>
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {label}. Automations belong to the agent of the folder they live in.
        </TooltipPopup>
      </Tooltip>
      <RunStatusMarker status={automationDisplayStatus(props.automation)} />
    </span>
  );
}
