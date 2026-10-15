/**
 * Every automation, on the overview's All tab: its name, when it runs next or
 * what starts it, and how its last run went (passing runs show nothing). The
 * one list of automations until they show up in their folders (#313).
 */
import {
  automationSubtitle,
  entryKey,
  sortAutomations,
} from "@t3tools/client-runtime/automations/list";
import { runDisplayStatus } from "@t3tools/client-runtime/automations/status";

import { useClientSettings } from "../../hooks/useSettings";
import { nextRunLabel } from "./automationFormat";
import { NO_AUTOMATIONS_HINT, OverviewEmptyState, OverviewLinkRow } from "./OverviewRows";
import { useAllAutomations } from "./useAutomations";

export function AutomationsAllList() {
  const { entries, loading } = useAllAutomations();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);

  if (entries.length === 0) {
    if (loading) return null;
    return <OverviewEmptyState title="No automations yet" description={NO_AUTOMATIONS_HINT} />;
  }

  const nextRun = nextRunLabel(timestampFormat);
  return (
    <ul aria-label="All automations" className="-mx-3 flex flex-col">
      {sortAutomations(entries, "attention").map((entry) => (
        <OverviewLinkRow
          key={entryKey(entry)}
          target={{ environmentId: entry.environmentId, automationId: entry.automation.id }}
          title={entry.automation.name}
          subtitle={automationSubtitle(entry.automation, nextRun)}
          status={entry.automation.lastRun ? runDisplayStatus(entry.automation.lastRun) : null}
        />
      ))}
    </ul>
  );
}
