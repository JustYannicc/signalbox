/**
 * `/automations` with no automation picked: what needs you (questions to
 * answer right here, and runs that failed), or a calm empty state. The list
 * of automations lives in the sidebar. `?view=steps` shows every trigger and
 * step an automation can use.
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
import { automationRoute } from "./automationFormat";
import { AutomationsPageShell } from "./AutomationsPageShell";
import { RunStatusMarker } from "./RunStatus";
import { StepsReference } from "./StepsReference";
import { useAllAutomations } from "./useAutomations";

export type AutomationsOverviewView = "needsYou" | "steps";

function NeedsYou() {
  useRelativeTimeTick(60_000);
  const { entries, loading } = useAllAutomations();
  const feed = attentionFeed(entries);

  if (feed.questions.length === 0 && feed.failed.length === 0) {
    if (loading) return null;
    const on = entries.filter((entry) => entry.automation.enabled).length;
    return (
      <div className="flex flex-col items-center gap-1 py-24 text-center">
        <p className="text-sm font-medium text-foreground">Nothing needs you</p>
        <p className="text-sm text-pretty text-muted-foreground">
          {entries.length === 0
            ? "Ask an agent in any thread to automate something."
            : on === 1
              ? "1 automation running quietly."
              : `${on} automations running quietly.`}
        </p>
      </div>
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
                <li key={entryKey(entry)}>
                  <Link
                    {...automationRoute({ environmentId, automationId: automation.id }, run.id)}
                    className="flex items-center gap-3 rounded-lg px-3 py-2.5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-sm font-medium text-foreground">
                        {runTitle(run)}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {automation.name} · {formatRelativeTimeLabel(run.startedAt)}
                      </span>
                    </span>
                    <RunStatusMarker status="failed" />
                  </Link>
                </li>
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
        <div className="ms-auto">
          <ToggleGroup
            aria-label="Automations view"
            variant="segmented"
            value={[props.view]}
            onValueChange={(next) =>
              void navigate({
                to: "/automations",
                search: next[0] === "steps" ? { view: "steps" } : {},
                replace: true,
              })
            }
          >
            <Toggle value="needsYou">Needs you</Toggle>
            <Toggle value="steps">Steps</Toggle>
          </ToggleGroup>
        </div>
      }
    >
      <div className="min-h-0 flex-1 border-t">
        <ScrollArea className="h-full">
          <WorkspacePageContainer>
            {props.view === "steps" ? <StepsReference /> : <NeedsYou />}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </AutomationsPageShell>
  );
}
