/**
 * Automation runs that need you, limited to what Focus keeps in sight. An
 * automation sits where Home puts it (`buildMappedIndex`); a run homed at
 * Work doesn't count while you're focused on Personal. `useNeedsYouCount`
 * reads this so the rail bell and Home stay quiet about hidden levels.
 */
import {
  automationAttention,
  type AutomationAttentionItem,
} from "../../automations/automationStatus";
import type { Automation } from "../../automations/automationModel";
import type { LevelKey } from "../../levels/levels";
import { buildMappedIndex, type MappedOverrides, type ProjectRef } from "../sections/mappedItems";
import { focusLevelOf, isInSight } from "./focusLevels";

export function automationAttentionInFocus(input: {
  automations: readonly Automation[];
  projects: readonly ProjectRef[];
  overrides: MappedOverrides;
  projectSectionOverrides: Readonly<Record<string, string>>;
  focused: LevelKey;
}): AutomationAttentionItem[] {
  const { projects, projectSectionOverrides } = input;
  const homesById = buildMappedIndex({
    automations: input.automations,
    projects,
    overrides: input.overrides,
  }).homesById;
  const projectByKey = new Map(projects.map((project) => [project.projectKey, project] as const));
  return automationAttention(input.automations).filter((item) => {
    const homes = homesById.get(`automation:${item.automation.id}`) ?? [];
    const levels = homes.map((key) => focusLevelOf(key, projectByKey, projectSectionOverrides));
    return isInSight({ levels, status: item.status }, input.focused, { projectSectionOverrides });
  });
}
