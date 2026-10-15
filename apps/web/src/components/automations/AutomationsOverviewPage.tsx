/**
 * `/automations` with no automation picked: what needs you (questions to
 * answer right here, and runs that failed), or a calm empty state.
 * `?view=all` lists every automation, and `?view=steps` shows every trigger
 * and step an automation can use.
 */
import { attentionFeed, entryKey } from "@t3tools/client-runtime/automations/list";
import { runTitle } from "@t3tools/client-runtime/automations/runs";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";

import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useRelativeTimeTick } from "../settings/settingsLayout";
import { ScrollArea } from "../ui/scroll-area";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { AskAnswer } from "./AskAnswer";
import { AutomationsAllList } from "./AutomationsAllList";
import { automationRoute } from "./automationFormat";
import { AutomationsPageShell } from "./AutomationsPageShell";
import { NewAutomationButton } from "./NewAutomationButton";
import { NO_AUTOMATIONS_HINT, OverviewEmptyState, OverviewLinkRow } from "./OverviewRows";
import { StepsReference } from "./StepsReference";
import { useAllAutomations } from "./useAutomations";

export type AutomationsOverviewView = "needsYou" | "all" | "steps";

/** The overview tab a `?view=` search value asks for; anything else is Needs you. */
export function overviewViewSearch(value: unknown): { view?: "all" | "steps" } {
  return value === "all" || value === "steps" ? { view: value } : {};
}

function NeedsYou() {
  useRelativeTimeTick(60_000);
  const { entries, loading } = useAllAutomations();
  const feed = attentionFeed(entries);

  if (feed.questions.length === 0 && feed.failed.length === 0) {
    if (loading) return null;
    const on = entries.filter((entry) => entry.automation.enabled).length;
    return (
      <OverviewEmptyState
        title="Nothing needs you"
        description={
          entries.length === 0
            ? NO_AUTOMATIONS_HINT
            : on === 1
              ? "1 automation running quietly."
              : `${on} automations running quietly.`
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {feed.questions.length > 0 ? (
        <section aria-labelledby="automations-questions" className="flex flex-col gap-2">
          <h2 id="automations-questions" className="text-xs font-medium text-muted-foreground">
            Waiting on your answer
          </h2>
          <ul className="flex flex-col gap-2">
            {feed.questions.map(({ entry, question }) => (
              <li
                key={`${entryKey(entry)}:${question.runId}:${question.stepKey}`}
                className="flex flex-col gap-2.5 rounded-lg border bg-card px-4 py-3"
              >
                <Link
                  {...automationRoute(
                    { environmentId: entry.environmentId, automationId: entry.automation.id },
                    question.runId,
                  )}
                  className="flex min-w-0 items-center gap-1.5 self-start text-xs text-muted-foreground hover:text-foreground"
                >
                  <span className="truncate">{entry.automation.name}</span>
                  <span aria-hidden>·</span>
                  <span className="shrink-0">{formatRelativeTimeLabel(question.since)}</span>
                  <ChevronRightIcon aria-hidden className="size-3.5 shrink-0" />
                </Link>
                <AskAnswer environmentId={entry.environmentId} question={question} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {feed.failed.length > 0 ? (
        <section aria-labelledby="automations-failed" className="flex flex-col gap-1">
          <h2 id="automations-failed" className="text-xs font-medium text-muted-foreground">
            Failed
          </h2>
          <ul className="-mx-3 flex flex-col">
            {feed.failed.map((entry) => {
              const { environmentId, automation } = entry;
              const run = automation.lastRun!;
              return (
                <OverviewLinkRow
                  key={entryKey(entry)}
                  target={{ environmentId, automationId: automation.id }}
                  runId={run.id}
                  title={runTitle(run)}
                  subtitle={`${automation.name} · ${formatRelativeTimeLabel(run.startedAt)}`}
                  status="failed"
                />
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export function AutomationsOverviewPage(props: { view: AutomationsOverviewView }) {
  const navigate = useNavigate();
  return (
    <AutomationsPageShell
      title={null}
      overview
      header={
        <div className="ms-auto flex items-center gap-2">
          <NewAutomationButton />
          <ToggleGroup
            aria-label="Automations view"
            variant="segmented"
            value={[props.view]}
            onValueChange={(next) =>
              void navigate({
                to: "/automations",
                search: overviewViewSearch(next[0]),
                replace: true,
              })
            }
          >
            <Toggle value="needsYou">Needs you</Toggle>
            <Toggle value="all">All</Toggle>
            <Toggle value="steps">Steps</Toggle>
          </ToggleGroup>
        </div>
      }
    >
      <div className="min-h-0 flex-1 border-t">
        <ScrollArea className="h-full">
          <WorkspacePageContainer>
            {props.view === "steps" ? (
              <StepsReference />
            ) : props.view === "all" ? (
              <AutomationsAllList />
            ) : (
              <NeedsYou />
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </AutomationsPageShell>
  );
}
