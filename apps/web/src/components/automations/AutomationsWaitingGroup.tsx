/**
 * Automations with a run waiting on the user, each with its question
 * and answer buttons inline. Shown first in the Automations rail and on top of
 * Pipeline, so approving or rejecting never needs the diagram.
 */
import {
  entryKey,
  waitsOnYou,
  type AutomationEntry,
} from "@t3tools/client-runtime/automations/list";
import { ChevronRightIcon } from "lucide-react";
import { memo, type ReactNode } from "react";

import { AskAnswer } from "./AskAnswer";
import { StatusIcon } from "./RunStatus";
import { useAllAutomations } from "./useAutomations";
import { useOpenAutomation } from "./useOpenAutomation";

export function RailSectionHeader(props: { children: ReactNode; accent?: boolean }) {
  return (
    <h3
      className={
        props.accent
          ? "flex h-8 items-center gap-2 px-2 text-xs font-medium text-warning-foreground"
          : "flex h-8 items-center gap-2 px-2 text-xs font-medium text-sidebar-muted-foreground/60"
      }
    >
      <span className="shrink-0">{props.children}</span>
      <span
        aria-hidden
        className={props.accent ? "h-px flex-1 bg-warning/24" : "h-px flex-1 bg-sidebar-border/60"}
      />
    </h3>
  );
}

const WaitingAutomation = memo(function WaitingAutomation(props: { entry: AutomationEntry }) {
  const { environmentId, automation } = props.entry;
  const openAutomation = useOpenAutomation();
  const firstRunId = automation.waiting[0]?.runId;

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-warning/32 bg-warning-surface p-2.5">
      <button
        type="button"
        className="-m-1 flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md p-1 text-left text-sm font-medium text-sidebar-foreground outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => openAutomation({ environmentId, automationId: automation.id }, firstRunId)}
      >
        <StatusIcon status="needsYou" className="size-3.5" />
        <span className="min-w-0 flex-1 truncate">{automation.name}</span>
        <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-sidebar-muted-foreground" />
      </button>
      {automation.waiting.map((question) => (
        <AskAnswer
          key={`${question.runId}:${question.stepKey}`}
          environmentId={environmentId}
          question={question}
          density="rail"
        />
      ))}
    </li>
  );
});

export function WaitingAutomationList(props: { entries: ReadonlyArray<AutomationEntry> }) {
  return (
    <ul className="flex flex-col gap-1.5 px-0.5">
      {props.entries.map((entry) => (
        <WaitingAutomation key={entryKey(entry)} entry={entry} />
      ))}
    </ul>
  );
}

/** Pipeline's top group. Renders nothing until an automation waits on the user. */
export function AutomationsWaitingGroup() {
  const { entries } = useAllAutomations();
  const waiting = entries.filter((entry) => waitsOnYou(entry.automation));
  if (waiting.length === 0) return null;
  return (
    <section
      aria-label="Automations waiting on you"
      className="max-h-[45%] shrink-0 overflow-y-auto px-2 pb-2"
    >
      <RailSectionHeader accent>Automations waiting on you</RailSectionHeader>
      <WaitingAutomationList entries={waiting} />
    </section>
  );
}
