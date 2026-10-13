/**
 * Where an automation lives in Home, and so whose it is. Automations have no
 * agents of their own: the agent of the level they live in is responsible for
 * them (the assistant at the top level). The folder is also the breadcrumb,
 * since automations have no list of their own.
 */
import { useMemo } from "react";

import { useAssistantIdentity } from "../assistant/assistantIdentity";
import { useLevelOptions } from "../levels/LevelOptionsProvider";
import { levelLabel, TOP_LEVEL, type LevelKey } from "../levels/levels";
import { useHomeProjectRefs } from "../levels/useHomeProjectRefs";
import {
  automationHomeTarget,
  resolveTarget,
  useMappedStore,
} from "../sidebar/sections/mappedItems";
import type { Automation } from "./automationModel";

export interface AutomationLevel {
  readonly key: LevelKey;
  /** Folder path, e.g. "Personal › signalbox" or "Top level". */
  readonly label: string;
  /** For `/agent/$agentId`; null at the top level, where the assistant is responsible. */
  readonly agentId: string | null;
  /** "signalbox agent", "Work agent", or the assistant's name. */
  readonly agentName: string;
}

export function useAutomationLevel(automation: Automation | null): AutomationLevel {
  const options = useLevelOptions();
  const projects = useHomeProjectRefs();
  const { name: assistantName } = useAssistantIdentity();
  const override = useMappedStore((state) =>
    automation ? state.homes[`automation:${automation.id}`] : undefined,
  );
  return useMemo(() => {
    const key = automation
      ? (override ?? resolveTarget(automationHomeTarget(automation.id), projects))
      : TOP_LEVEL;
    const option = options.find((candidate) => candidate.key === key);
    if (!option || option.agentId === null) {
      return {
        key: option ? key : TOP_LEVEL,
        label: option?.label ?? levelLabel(TOP_LEVEL),
        agentId: null,
        agentName: assistantName,
      };
    }
    return {
      key,
      label: option.label,
      agentId: option.agentId,
      agentName: option.agentName ?? `${option.name} agent`,
    };
  }, [assistantName, automation, options, override, projects]);
}
