/**
 * Compact link to a computer, for embedding where a task, chat, or the
 * assistant's trace mentions one: OS, name, state, and cost so far.
 */
import { Link } from "@tanstack/react-router";

import { ComputerOsIcon } from "./computerPrimitives";
import { STATE_LABEL, formatUsd, totalCost, type Computer } from "./computerModel";

export function ComputerChip({ computer }: { readonly computer: Computer }) {
  return (
    <Link
      to="/computers/$computerId"
      params={{ computerId: computer.id }}
      className="inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-md border border-border px-2 text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ComputerOsIcon os={computer.os} className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate font-medium text-foreground">{computer.name}</span>
      <span className="shrink-0 text-muted-foreground tabular-nums">
        {STATE_LABEL[computer.state]} · {formatUsd(totalCost(computer))}
      </span>
    </Link>
  );
}
