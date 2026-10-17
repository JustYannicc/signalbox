/**
 * An automation's runs, as a column beside its diagram (#313). Runs that need
 * you sit on top; a run that went fine carries no marker. Picking a run shows
 * it: traced on the diagram, or as its chat when that's what's open. Phones
 * keep the run picker over the diagram instead.
 */
import type { AutomationRunSummary, TimestampFormat } from "@t3tools/contracts";
import { runsByAttention } from "@t3tools/client-runtime/automations/list";
import { runTitle } from "@t3tools/client-runtime/automations/runs";
import { runDisplayStatus } from "@t3tools/client-runtime/automations/status";

import { cn } from "~/lib/utils";
import { useClientSettings } from "../../hooks/useSettings";
import { formatDayAwareTimestamp } from "../../timestampFormat";
import { useRelativeTimeTick } from "../settings/settingsLayout";
import { RunStatusMarker } from "./RunStatus";

function RunRow(props: {
  run: AutomationRunSummary;
  active: boolean;
  timestampFormat: TimestampFormat;
  onSelect: () => void;
}) {
  const { run, active } = props;
  return (
    <li>
      <button
        type="button"
        aria-current={active ? "true" : undefined}
        onClick={props.onSelect}
        className={cn(
          "flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-left outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset",
          active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60",
        )}
      >
        <span className={cn("truncate text-sm", active && "font-medium")}>{runTitle(run)}</span>
        <span className="flex min-w-0 items-center gap-2">
          {/* Clock time, so a schedule's runs read as its schedule. */}
          <time
            dateTime={run.startedAt}
            className="shrink-0 text-xs tabular-nums text-muted-foreground/80"
          >
            {formatDayAwareTimestamp(run.startedAt, props.timestampFormat)}
          </time>
          <RunStatusMarker status={runDisplayStatus(run)} />
        </span>
      </button>
    </li>
  );
}

export function AutomationRunList(props: {
  runs: ReadonlyArray<AutomationRunSummary>;
  selectedId: string | null;
  onSelect: (runId: string) => void;
}) {
  useRelativeTimeTick(60_000);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const { needsYou, rest } = runsByAttention(props.runs);
  const row = (run: AutomationRunSummary) => (
    <RunRow
      key={run.id}
      run={run}
      active={run.id === props.selectedId}
      timestampFormat={timestampFormat}
      onSelect={() => props.onSelect(run.id)}
    />
  );

  return (
    <aside
      aria-label="Runs"
      className="hidden w-64 shrink-0 flex-col overflow-y-auto border-t border-r p-2 @3xl/automation:flex"
    >
      <h2 className="px-2.5 pt-1 pb-2 text-xs font-medium text-muted-foreground">Runs</h2>
      {props.runs.length === 0 ? (
        <p className="px-2.5 text-xs text-muted-foreground">
          No runs yet. Run it now to see each step light up.
        </p>
      ) : (
        <ul className="flex flex-col gap-px">
          {needsYou.map(row)}
          {needsYou.length > 0 && rest.length > 0 ? (
            <li aria-hidden className="mx-2.5 my-1.5 border-t" />
          ) : null}
          {rest.map(row)}
        </ul>
      )}
    </aside>
  );
}
