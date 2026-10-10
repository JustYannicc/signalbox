/**
 * What a run can tell you when something went wrong: a failure's why, fix
 * and link from the engine, and the code's `console` lines.
 */
import type { AutomationErrorDetail, AutomationRunLog } from "@t3tools/contracts";
import { ChevronRightIcon, ExternalLinkIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useClientSettings } from "../../hooks/useSettings";
import { formatTimestamp } from "../../timestampFormat";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";

/** Lines kept on screen; the run's wide event and `automation_run_read` have the rest. */
const LOG_LIMIT = 200;

/** Why a step or run failed and what to do, under its error. Nothing when the engine doesn't know. */
export function ErrorHelp(props: { detail: AutomationErrorDetail | null | undefined }) {
  const { detail } = props;
  if (!detail || (!detail.why && !detail.fix && !detail.link)) return null;
  return (
    <div className="flex flex-col gap-1 text-xs text-pretty break-words text-muted-foreground">
      {detail.why ? <p>{detail.why}</p> : null}
      {detail.fix ? (
        <p>
          <span className="font-medium text-foreground">How to fix: </span>
          {detail.fix}
        </p>
      ) : null}
      {detail.link ? (
        <a
          href={detail.link}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 self-start underline-offset-2 hover:text-foreground hover:underline"
        >
          Learn more
          <ExternalLinkIcon aria-hidden className="size-3" />
        </a>
      ) : null}
    </div>
  );
}

const LEVEL_TONE: Record<AutomationRunLog["level"], string> = {
  log: "text-foreground",
  info: "text-foreground",
  debug: "text-muted-foreground",
  warn: "text-warning-foreground",
  error: "text-destructive-foreground",
};

/** The code's `console` lines, folded until asked for, newest at the bottom. */
export function RunLogs(props: { logs: ReadonlyArray<AutomationRunLog> }) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  if (props.logs.length === 0) return null;
  const hidden = Math.max(0, props.logs.length - LOG_LIMIT);
  // Lines only ever append, so a line's place in the whole log is a stable key.
  const shown = props.logs.slice(hidden).map((log, offset) => ({ log, line: hidden + offset }));
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1.5 self-start rounded-md text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 transition-transform group-data-panel-open:rotate-90"
        />
        Logs
        <span className="font-normal tabular-nums">{props.logs.length}</span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        {hidden > 0 ? (
          <p className="pt-2 pb-1 text-xs text-muted-foreground">
            Showing the last {LOG_LIMIT} lines.
          </p>
        ) : null}
        <div
          // Opens scrolled to the newest line.
          ref={(element) => {
            if (element) element.scrollTop = element.scrollHeight;
          }}
          className={cn(
            "max-h-80 overflow-auto rounded-md bg-muted/50 px-2.5 py-2 font-mono text-xs",
            hidden === 0 && "mt-2",
          )}
        >
          {shown.map(({ log, line }) => (
            <div key={line} className="flex gap-2 whitespace-pre-wrap break-words">
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {formatTimestamp(log.at, timestampFormat)}
              </span>
              <span className={cn("min-w-0", LEVEL_TONE[log.level])}>{log.message}</span>
            </div>
          ))}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
