/**
 * The automation's run history, beside its workflow. Picking a run traces it
 * on the canvas (which step it reached, where it failed); its chat is one
 * click further. Runs that need you sit on top; passing runs carry no marker.
 */
import { cn } from "~/lib/utils";
import type { Automation, AutomationRun } from "./automationModel";
import { automationSubtitle, formatRunStarted } from "./automationFormat";
import { automationAttention, runDisplayStatus } from "./automationStatus";
import { RunStatusMarker } from "./RunStatusMarker";
import { useAssistantName } from "./useAssistantName";

function RunRow(props: { run: AutomationRun; active: boolean; onSelect: () => void }) {
  const nameText = useAssistantName();
  return (
    <li>
      <button
        type="button"
        aria-current={props.active ? "true" : undefined}
        onClick={props.onSelect}
        className={cn(
          "flex h-9 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left text-sm outline-hidden ring-ring focus-visible:ring-2",
          props.active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60",
        )}
      >
        <span className="min-w-0 flex-1 truncate">{nameText(props.run.title)}</span>
        <RunStatusMarker status={runDisplayStatus(props.run)} />
        <span className="shrink-0 text-xs text-muted-foreground/70 tabular-nums">
          {formatRunStarted(props.run)}
        </span>
      </button>
    </li>
  );
}

export function AutomationRunList(props: {
  automation: Automation;
  activeRunId: string | null;
  onSelect: (runId: string) => void;
}) {
  const { automation } = props;
  const urgent = automationAttention([automation]).map((item) => item.run);
  const urgentIds = new Set(urgent.map((run) => run.id));
  const rest = automation.runs.filter((run) => !urgentIds.has(run.id));

  return (
    <aside
      aria-label="Runs"
      className="hidden w-64 shrink-0 flex-col overflow-y-auto border-r p-2 md:flex"
    >
      <div className="px-2.5 pt-1 pb-2">
        <h2 className="text-sm font-medium text-foreground">Runs</h2>
        <p className="truncate text-xs text-muted-foreground">{automationSubtitle(automation)}</p>
      </div>
      {automation.runs.length === 0 ? (
        <p className="px-2.5 text-xs text-muted-foreground">No runs yet.</p>
      ) : (
        <ul className="flex flex-col gap-px">
          {urgent.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              active={run.id === props.activeRunId}
              onSelect={() => props.onSelect(run.id)}
            />
          ))}
          {urgent.length > 0 && rest.length > 0 ? (
            <li aria-hidden className="mx-2.5 my-1 border-t" />
          ) : null}
          {rest.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              active={run.id === props.activeRunId}
              onSelect={() => props.onSelect(run.id)}
            />
          ))}
        </ul>
      )}
    </aside>
  );
}
