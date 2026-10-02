import { Link } from "@tanstack/react-router";
import { AppWindowIcon, MonitorIcon, TerminalSquareIcon } from "lucide-react";

import { Badge } from "../ui/badge";
import { toastManager } from "../ui/toast";
import {
  OS_LABEL,
  STATE_LABEL,
  provenanceParts,
  type Computer,
  type ComputerOs,
  type ComputerState,
} from "./computerModel";

const STATE_VARIANT = {
  live: "success",
  paused: "warning",
  released: "secondary",
} as const satisfies Record<ComputerState, "success" | "warning" | "secondary">;

export function ComputerStateBadge({ state }: { readonly state: ComputerState }) {
  return <Badge variant={STATE_VARIANT[state]}>{STATE_LABEL[state]}</Badge>;
}

const OS_ICON = {
  linux: TerminalSquareIcon,
  windows: AppWindowIcon,
  macos: MonitorIcon,
} as const satisfies Record<ComputerOs, typeof MonitorIcon>;

export function ComputerOsIcon({ os, className }: { os: ComputerOs; className?: string }) {
  const Icon = OS_ICON[os];
  return <Icon aria-hidden className={className} />;
}

export function ComputerOsBadge({ os, version }: { os: ComputerOs; version: string }) {
  return (
    <Badge variant="outline">
      <ComputerOsIcon os={os} />
      {OS_LABEL[os]}
      <span className="font-normal text-muted-foreground">{version}</span>
    </Badge>
  );
}

/** Placeholder feedback for computer actions that have no backend yet. */
export function notifyComputerPrototype(title: string, description: string) {
  toastManager.add({
    id: "computers-prototype",
    type: "info",
    title,
    description: `${description} Prototype only; no real computer changed.`,
    timeout: 3000,
  });
}

/** "Acquired by task 'X' · 12m", with the task or chat linked. Don't nest inside another link. */
export function ComputerProvenance({ computer }: { computer: Computer }) {
  const { verb, kind, age } = provenanceParts(computer);
  const { title, sharedThreadId } = computer.acquiredBy;
  const linkClass = "font-medium underline-offset-4 hover:underline";
  return (
    <p className="text-sm text-foreground">
      {verb} {kind}{" "}
      {sharedThreadId ? (
        <Link to="/shared/$threadId" params={{ threadId: sharedThreadId }} className={linkClass}>
          {title}
        </Link>
      ) : (
        <Link to="/assistant" className={linkClass}>
          {title}
        </Link>
      )}
      <span className="text-muted-foreground"> · {age}</span>
    </p>
  );
}
