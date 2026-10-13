/**
 * How run status and step ownership look on the canvas and in the details
 * panel: status badge icons and tones, and the owner pill.
 */
import {
  Building2Icon,
  CheckIcon,
  HourglassIcon,
  LoaderIcon,
  MinusIcon,
  UserIcon,
  XIcon,
} from "lucide-react";
import { createElement, type ComponentType, type SVGProps } from "react";

import { cn } from "~/lib/utils";
import type { NodeOwner, NodeRunStatus } from "./automationModel";

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

export const NODE_STATUS_ICON: Record<NodeRunStatus, IconComponent> = {
  success: CheckIcon,
  failed: XIcon,
  running: LoaderIcon,
  waiting: HourglassIcon,
  skipped: MinusIcon,
};

export const NODE_STATUS_BADGE_CLASS: Record<NodeRunStatus, string> = {
  success: "bg-success/16 text-success-foreground",
  failed: "bg-destructive/16 text-destructive-foreground",
  running: "bg-info/16 text-info-foreground",
  waiting: "bg-warning/16 text-warning-foreground",
  skipped: "bg-muted text-muted-foreground",
};

export const OWNER_ICON: Record<NodeOwner["scope"], IconComponent> = {
  company: Building2Icon,
  personal: UserIcon,
};

/** Text tone per owner, shared by node pills, lanes, and the details panel. */
export const OWNER_TEXT_CLASS: Record<NodeOwner["scope"], string> = {
  company: "text-info-foreground",
  personal: "text-primary",
};

export function OwnerPill(props: { owner: NodeOwner; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border bg-card px-1.5 py-px text-3xs font-medium whitespace-nowrap",
        OWNER_TEXT_CLASS[props.owner.scope],
        props.className,
      )}
    >
      {createElement(OWNER_ICON[props.owner.scope], { "aria-hidden": true, className: "size-2.5" })}
      {props.owner.label}
    </span>
  );
}

export function NodeStatusIcon(props: { status: NodeRunStatus; className?: string }) {
  return createElement(NODE_STATUS_ICON[props.status], {
    "aria-hidden": true,
    className: props.className,
    strokeWidth: 2.5,
  });
}
