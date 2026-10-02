/**
 * `/computers`: every real OS an agent acquired, live first. Placeholder data.
 */
import { Link } from "@tanstack/react-router";

import { isElectron } from "../../env";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { COMPUTERS } from "./computerFixtures";
import { ComputerOsIcon, ComputerStateBadge } from "./computerPrimitives";
import {
  OS_LABEL,
  formatUsd,
  provenanceText,
  totalCost,
  type Computer,
  type ComputerState,
} from "./computerModel";

function ComputerRow({ computer }: { computer: Computer }) {
  const rate =
    computer.state === "live"
      ? `${formatUsd(computer.computeRateUsdPerHour)}/h`
      : computer.retainedGb > 0
        ? `${computer.retainedGb} GB kept`
        : "nothing billed";
  return (
    <li>
      <Link
        to="/computers/$computerId"
        params={{ computerId: computer.id }}
        className="flex items-center gap-4 rounded-lg px-3 py-3 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <ComputerOsIcon os={computer.os} className="size-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{computer.name}</span>
            <ComputerStateBadge state={computer.state} />
          </span>
          <span className="truncate text-xs text-muted-foreground">{provenanceText(computer)}</span>
        </span>
        <span className="hidden shrink-0 text-xs text-muted-foreground md:block">
          {OS_LABEL[computer.os]} · {computer.provider} · {computer.region}
        </span>
        <span className="flex w-24 shrink-0 flex-col items-end gap-0.5">
          <span className="text-sm text-foreground tabular-nums">
            {formatUsd(totalCost(computer))}
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">{rate}</span>
        </span>
      </Link>
    </li>
  );
}

const GROUPS: ReadonlyArray<{ state: ComputerState; heading: string }> = [
  { state: "live", heading: "Live" },
  { state: "paused", heading: "Paused" },
  { state: "released", heading: "Recently released" },
];

export function ComputersIndexPage() {
  const liveRate = COMPUTERS.filter((computer) => computer.state === "live").reduce(
    (sum, computer) => sum + computer.computeRateUsdPerHour,
    0,
  );
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Computers breadcrumb" className="min-w-0">
            <WorkspaceBreadcrumbItem current>
              <h1>Computers</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <span className="ms-auto text-xs text-muted-foreground tabular-nums">
            Live compute {formatUsd(liveRate)}/h
          </span>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            <p className="max-w-prose text-sm text-muted-foreground">
              Agents acquire a real Linux, Windows, or macOS computer only when a task needs one,
              like opening a browser to check the app they built. Files sync back to the durable
              workspace, and the computer is released when the work is done.
            </p>
            {GROUPS.map(({ state, heading }) => {
              const computers = COMPUTERS.filter((computer) => computer.state === state);
              if (computers.length === 0) return null;
              return (
                <section
                  key={state}
                  aria-labelledby={`computers-${state}`}
                  className="flex flex-col gap-1"
                >
                  <h2
                    id={`computers-${state}`}
                    className="px-3 text-xs font-medium text-muted-foreground"
                  >
                    {heading}
                  </h2>
                  <ul className="flex flex-col">
                    {computers.map((computer) => (
                      <ComputerRow key={computer.id} computer={computer} />
                    ))}
                  </ul>
                </section>
              );
            })}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
