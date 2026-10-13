import type { Automation } from "@t3tools/contracts";

/**
 * Automations change through an agent: the user says what they want and the
 * agent rewrites the code with the automation_* tools. Clients open a new
 * thread in the automation's project with one of these started, so the user
 * only types what to change.
 */

type Named = Pick<Automation, "id" | "name">;

export const NEW_AUTOMATION_PROMPT = "Create an automation that ";

export const changePrompt = (automation: Named) =>
  `Change the automation "${automation.name}" (id ${automation.id}): `;

export const addStepPrompt = (automation: Named, step: string) =>
  `Add a "${step}" step to the automation "${automation.name}" (id ${automation.id}): `;

export const addTriggerPrompt = (automation: Named, trigger: string) =>
  `Make the automation "${automation.name}" (id ${automation.id}) also run ${trigger.toLowerCase()}: `;

export const duplicatePrompt = (automation: Named) =>
  `Duplicate the automation "${automation.name}" (id ${automation.id}) as "${automation.name} (copy)", then change it so that `;
