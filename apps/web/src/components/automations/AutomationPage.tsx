/**
 * One automation: a header with its controls, then one of three views. Run
 * shows a run as a chat of what happened, Diagram draws it over the diagram,
 * Code shows the file the diagram is derived from. A run picked in `?run=`
 * shows; without one the latest run does. A pending draft adds a bar to
 * switch Diagram and Code between the live version and the draft.
 */
import type { Automation, AutomationDetail, EnvironmentId } from "@t3tools/contracts";
import { triggerSummary } from "@t3tools/client-runtime/automations/triggers";
import * as Schema from "effect/Schema";
import { useNavigate } from "@tanstack/react-router";
import { CalendarClockIcon, PlayIcon, WebhookIcon, ZapIcon, type LucideIcon } from "lucide-react";
import { createElement, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { automationState } from "../../state/automations";
import { formatRelativeTimeUntil } from "../../timestampFormat";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { AutomationActions } from "./AutomationActions";
import { AutomationDraftBar, type DraftSide } from "./AutomationDraftBar";
import { AutomationView, automationRoute } from "./automationFormat";
import { AutomationRunChat } from "./AutomationRunChat";
import { AutomationsPageShell } from "./AutomationsPageShell";
import { AutomationSourceView } from "./AutomationSourceView";
import { AutomationWorkspace } from "./AutomationWorkspace";

const isAutomationView = Schema.is(AutomationView);

function triggerIcon(automation: Pick<Automation, "triggers">): LucideIcon {
  if (automation.triggers.some((trigger) => "webhook" in trigger)) return WebhookIcon;
  if (automation.triggers.some((trigger) => "on" in trigger)) return ZapIcon;
  return automation.triggers.length > 0 ? CalendarClockIcon : PlayIcon;
}

function nextRunText(automation: Automation): string | null {
  if (automation.version === 0) return "Not published yet";
  if (!automation.enabled) return "Paused · runs only when you run it";
  if (!automation.nextRunAt) return null;
  const until = formatRelativeTimeUntil(automation.nextRunAt);
  return until?.suffix ? `Next run in ${until.value}` : "Next run in a moment";
}

function Loading(props: { label: string }) {
  return (
    <div className="flex flex-1 flex-col items-center gap-9 border-t pt-10" role="status">
      <span className="sr-only">{props.label}</span>
      {[0, 1, 2].map((index) => (
        <Skeleton key={index} className="h-15 w-62" />
      ))}
    </div>
  );
}

function Notice(props: { title: string; children: string }) {
  return (
    <div className="flex flex-1 flex-col border-t">
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{props.title}</EmptyTitle>
          <EmptyDescription>{props.children}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}

export function AutomationPage(props: {
  environmentId: EnvironmentId;
  automationId: string;
  runId: string | null;
  view: AutomationView;
  line: number | null;
}) {
  const navigate = useNavigate();
  const { environmentId } = props;
  const detailQuery = useEnvironmentQuery(
    automationState.detail({ environmentId, input: { automationId: props.automationId } }),
  );
  const detail: AutomationDetail | null = detailQuery.data;
  // An older run linked by `?run=` still loads after it drops out of the recent list.
  const shownRunId = props.runId ?? detail?.runs[0]?.id ?? null;
  const runQuery = useEnvironmentQuery(
    shownRunId ? automationState.run({ environmentId, input: { runId: shownRunId } }) : null,
  );
  const runDetail = runQuery.data?.run.id === shownRunId ? runQuery.data : null;
  const [draftSide, setDraftSide] = useState<DraftSide>("draft");

  if (!detail) {
    return (
      <AutomationsPageShell title={null}>
        {detailQuery.error ? (
          <Notice title="This automation isn't available">
            {`It may have been deleted, or its environment is offline. ${detailQuery.error}`}
          </Notice>
        ) : (
          <Loading label="Loading automation" />
        )}
      </AutomationsPageShell>
    );
  }

  const { automation } = detail;
  const target = { environmentId, automationId: automation.id };
  const show = (view: AutomationView, runId: string | null, line?: number) => {
    const route = automationRoute(target, runId, view);
    void navigate({
      ...route,
      search: line ? { ...route.search, line } : route.search,
      replace: true,
    });
  };
  const nextRun = nextRunText(automation);
  const TriggerIcon = triggerIcon(automation);
  const selectedRun = detail.runs.find((run) => run.id === shownRunId) ?? runDetail?.run ?? null;
  // A never-published automation has nothing live to show.
  const shownDraft =
    detail.draft && (draftSide === "draft" || automation.version === 0) ? detail.draft : null;

  return (
    <AutomationsPageShell
      title={automation.name}
      header={
        <div className="ms-auto flex shrink-0 items-center gap-3">
          <ToggleGroup
            aria-label="Automation view"
            variant="segmented"
            value={[props.view]}
            onValueChange={(next) => {
              const value = next[0];
              if (isAutomationView(value)) show(value, props.runId);
            }}
          >
            <Toggle value="run" disabled={!shownRunId}>
              Run
            </Toggle>
            <Toggle value="diagram">Diagram</Toggle>
            <Toggle value="code">Code</Toggle>
          </ToggleGroup>
          <AutomationActions
            environmentId={environmentId}
            automation={automation}
            shownRun={runDetail}
            onRunStarted={(runId) => show("run", runId)}
          />
        </div>
      }
    >
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-2 text-xs">
        <span className="flex items-center gap-1.5 font-medium text-foreground">
          {createElement(TriggerIcon, {
            "aria-hidden": true,
            className: "size-3.5 text-muted-foreground",
          })}
          {triggerSummary(automation.triggers)}
        </span>
        {nextRun ? <span className="text-muted-foreground">{nextRun}</span> : null}
        {automation.description ? (
          <span className="line-clamp-2 min-w-0 flex-1 text-muted-foreground">
            {automation.description}
          </span>
        ) : null}
        {automation.intent ? (
          <span className="line-clamp-2 w-full text-muted-foreground/80">
            {`Asked for: “${automation.intent}”`}
          </span>
        ) : null}
      </div>
      {detail.draft ? (
        <AutomationDraftBar
          environmentId={environmentId}
          automation={automation}
          draft={detail.draft}
          side={draftSide}
          onSideChange={setDraftSide}
        />
      ) : null}
      {props.view === "code" ? (
        <AutomationSourceView
          environmentId={environmentId}
          automation={automation}
          source={shownDraft?.source ?? detail.source}
          compareTo={shownDraft && automation.version > 0 ? detail.source : null}
          line={props.line}
        />
      ) : props.view === "run" ? (
        runDetail ? (
          <AutomationRunChat
            environmentId={environmentId}
            run={runDetail}
            version={automation.version}
            triggerIcon={TriggerIcon}
            onShowOnDiagram={() => show("diagram", runDetail.run.id)}
          />
        ) : runQuery.error ? (
          <Notice title="Couldn't load this run">{runQuery.error}</Notice>
        ) : shownRunId ? (
          <Loading label="Loading run" />
        ) : (
          <Notice title="No runs yet">Run it now to see what each step does.</Notice>
        )
      ) : (
        <div className="flex min-h-0 flex-1 border-t">
          <AutomationWorkspace
            environmentId={environmentId}
            detail={detail}
            runDetail={runDetail}
            selectedRun={selectedRun}
            runError={props.runId ? runQuery.error : null}
            triggerIcon={TriggerIcon}
            onSelectRun={(runId) => show("diagram", runId)}
            onOpenRunChat={(runId) => show("run", runId)}
            onShowLine={(line) => show("code", props.runId, line)}
            draft={shownDraft}
          />
        </div>
      )}
    </AutomationsPageShell>
  );
}
