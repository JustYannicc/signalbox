import { useAtomValue } from "@effect/atom-react";
import type { AutomationEntry } from "@t3tools/client-runtime/automations/list";
import { environmentListKey } from "@t3tools/client-runtime/state/automations";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useConnectedEnvironmentIds } from "../../state/environments";
import { automationState } from "../../state/automations";

export interface AutomationsView {
  readonly entries: ReadonlyArray<AutomationEntry>;
  /** True until every connected environment answered once. */
  readonly loading: boolean;
  /** Environments whose list has arrived, so new arrivals can be told from new automations. */
  readonly loaded: ReadonlySet<EnvironmentId>;
}

function useListKey() {
  const environmentIds = useConnectedEnvironmentIds();
  return useMemo(() => environmentListKey(environmentIds), [environmentIds]);
}

/**
 * Every connected environment's automations, merged. The rail, its badge and
 * the palette share one subscription per environment. An environment whose
 * server has no automations (an older version) simply contributes nothing.
 */
export function useAllAutomations(): AutomationsView {
  const lists = useAtomValue(automationState.lists(useListKey()));
  return useMemo(() => {
    const entries: AutomationEntry[] = [];
    const loaded = new Set<EnvironmentId>();
    let loading = false;
    for (const list of lists) {
      loading ||= list.loading;
      if (list.automations === null) continue;
      loaded.add(list.environmentId);
      for (const automation of list.automations) {
        entries.push({ environmentId: list.environmentId, automation });
      }
    }
    return { entries, loading, loaded };
  }, [lists]);
}

/** How many automations have a run waiting on the user, for the rail badge. Redraws only when it changes. */
export function useWaitingAutomationCount(): number {
  return useAtomValue(automationState.waitingCount(useListKey()));
}
