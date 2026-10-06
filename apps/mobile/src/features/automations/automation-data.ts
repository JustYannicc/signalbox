import { useAtomValue } from "@effect/atom-react";
import { environmentListKey } from "@t3tools/client-runtime/state/automations";
import type { Automation } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useMemo } from "react";

import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { automationState } from "../../state/automations";

export type AutomationEnvironment = EnvironmentPresentation;

export interface EnvironmentAutomations {
  readonly environment: AutomationEnvironment;
  readonly automations: ReadonlyArray<Automation> | null;
  readonly error: string | null;
}

/** Environments that can answer automation requests right now. */
export function useAutomationEnvironments(): ReadonlyArray<AutomationEnvironment> {
  const { environments } = useEnvironments();
  return useMemo(
    () =>
      environments.filter(
        (entry) => entry.connection.phase === "connected" && entry.serverConfig !== null,
      ),
    [environments],
  );
}

/** The shared atoms' key for these environments. */
const listKey = (environments: ReadonlyArray<AutomationEnvironment>) =>
  environmentListKey(environments.map((environment) => environment.environmentId));

function errorText(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Couldn't load automations.";
}

/** Every connected environment's live automation list, in the order the app lists environments. */
export function useAutomationLists(): ReadonlyArray<EnvironmentAutomations> {
  const environments = useAutomationEnvironments();
  const lists = useAtomValue(automationState.lists(listKey(environments)));
  return useMemo(() => {
    const byId = new Map(lists.map((list) => [list.environmentId, list]));
    return environments.map((environment): EnvironmentAutomations => {
      const list = byId.get(environment.environmentId);
      return {
        environment,
        automations: list?.automations ?? null,
        error: list?.failure ? errorText(list.failure) : null,
      };
    });
  }, [environments, lists]);
}

/** How many automations wait on an answer; a number, so badges only redraw when it changes. */
export function useWaitingAutomationCount(): number {
  return useAtomValue(automationState.waitingCount(listKey(useAutomationEnvironments())));
}

/** Automations with questions waiting on you, with their longest-waiting question, oldest first. */
export function waitingAutomations(lists: ReadonlyArray<EnvironmentAutomations>) {
  return lists
    .flatMap(({ environment, automations }) =>
      (automations ?? []).flatMap((automation) => {
        const question = automation.waiting[0];
        return question ? [{ environmentId: environment.environmentId, automation, question }] : [];
      }),
    )
    .sort((left, right) => left.question.since.localeCompare(right.question.since));
}

export type WaitingAutomation = ReturnType<typeof waitingAutomations>[number];
