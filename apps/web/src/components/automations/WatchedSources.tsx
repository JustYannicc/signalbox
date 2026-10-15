/**
 * What an automation's triggers or a run's waiting steps watch in connected
 * services, and how reading them goes: "Watching Github workflow runs for repo
 * · checked 2m ago".
 */
import type { AutomationSourceStatus } from "@t3tools/contracts";
import { watchedSource } from "@t3tools/client-runtime/automations/triggers";
import { EyeIcon, EyeOffIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useRelativeTimeTick } from "../settings/settingsLayout";

export function WatchedSources(props: {
  sources: ReadonlyArray<AutomationSourceStatus> | undefined;
  className?: string;
}) {
  const nowMs = useRelativeTimeTick(60_000);
  if (!props.sources || props.sources.length === 0) return null;
  return (
    <ul className={cn("flex flex-col gap-0.5 text-xs", props.className)}>
      {props.sources.map((source) => {
        const { subject, status, trouble } = watchedSource(source, nowMs);
        const Icon = source.status === "paused" ? EyeOffIcon : EyeIcon;
        return (
          <li
            key={source.sourceId}
            className={cn(
              "flex min-w-0 items-center gap-1.5",
              trouble ? "text-destructive-foreground" : "text-muted-foreground",
            )}
          >
            <Icon aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">{`Watching ${subject} · ${status}`}</span>
            {trouble && source.error ? (
              <span className="min-w-0 truncate text-muted-foreground">{source.error}</span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
