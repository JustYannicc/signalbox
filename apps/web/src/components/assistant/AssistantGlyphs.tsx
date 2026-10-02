/** Small shared marks for the Assistant prototype: statuses, avatars and item types. */
import { MessageCircleIcon, SquareCheckIcon, WorkflowIcon, ZapIcon } from "lucide-react";
import { useMemo } from "react";

import { cn } from "~/lib/utils";
import { HarnessAvatar } from "../chat/HarnessAvatar";
import type { DelegationStatus, ThreadKind, TraceNodeFixture } from "./assistantFixtures";
import { AssistantIcon } from "./AssistantIcon";
import { useAssistantIdentity } from "./assistantIdentity";
import { statusDisplay } from "./assistantModel";
import { AssistantAvatar, generateAvatar, type AvatarExpression } from "./avatar";

/** The Pipeline's status icon alone, labelled for screen readers. */
export function StatusIcon(props: {
  status: DelegationStatus;
  waitingOn?: string | undefined;
  className?: string;
}) {
  const display = statusDisplay(props.status, props.waitingOn);
  const Icon = display.icon;
  return (
    <Icon
      role="img"
      aria-label={display.description}
      className={cn("size-3.5 shrink-0", display.colorClass, props.className)}
    />
  );
}

/** The Pipeline's status icon plus its short label ("Approval", "Waiting on Flynn"). */
export function StatusLabel(props: {
  status: DelegationStatus;
  waitingOn?: string | undefined;
  /** Show the full wording ("Needs your approval") instead of the short label. */
  full?: boolean;
}) {
  const display = statusDisplay(props.status, props.waitingOn);
  const Icon = display.icon;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 text-xs", display.colorClass)}>
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {props.full ? display.description : display.label}
    </span>
  );
}

/** Chat or Task, as one icon. */
export function ThreadKindIcon(props: { kind: ThreadKind; className?: string | undefined }) {
  const Icon = props.kind === "task" ? SquareCheckIcon : MessageCircleIcon;
  return (
    <Icon
      role="img"
      aria-label={props.kind === "task" ? "Task" : "Chat"}
      className={cn("size-3.5 shrink-0 text-muted-foreground", props.className)}
    />
  );
}

/** A node's display name; the assistant node follows the user's chosen name. */
export function NodeName(props: { node: TraceNodeFixture }) {
  const identity = useAssistantIdentity();
  return <>{props.node.kind === "assistant" ? identity.name : props.node.name}</>;
}

/** "section:work/northwind" → "section-northwind", matching the `/agent/$agentId` ids. */
export function agentIdForNode(node: TraceNodeFixture): string {
  const key = node.id.split(/[:/]/).at(-1) ?? node.id;
  return `${node.kind}-${key}`;
}

/**
 * A supervisor agent's avatar. Section and project agents stay unnamed, so each
 * gets a face generated from its id: stable across renders and distinct per agent.
 */
export function SupervisorAvatar(props: {
  agentId: string;
  size: number;
  expression?: AvatarExpression;
  className?: string | undefined;
}) {
  const config = useMemo(() => generateAvatar(props.agentId), [props.agentId]);
  return (
    <AssistantAvatar
      config={config}
      size={props.size}
      {...(props.expression ? { expression: props.expression } : {})}
      {...(props.className ? { className: props.className } : {})}
    />
  );
}

/** The mark for a trace node: avatars for supervisors, the type icon for threads. */
export function NodeGlyph(props: { node: TraceNodeFixture; className?: string | undefined }) {
  const { node } = props;
  if (node.kind === "assistant") return <AssistantIcon className={props.className} />;
  if (node.kind === "section" || node.kind === "project" || node.kind === "workflow") {
    return (
      <SupervisorAvatar agentId={agentIdForNode(node)} size={16} className={props.className} />
    );
  }
  if (node.kind === "automations" || node.kind === "trigger") {
    const Icon = node.kind === "trigger" ? ZapIcon : WorkflowIcon;
    return (
      <Icon
        aria-hidden
        className={cn("size-3.5 shrink-0 text-muted-foreground", props.className)}
      />
    );
  }
  if (node.threadKind) return <ThreadKindIcon kind={node.threadKind} className={props.className} />;
  return null;
}

/** The harness a thread runs on, as the shared per-provider harness avatar. */
export function HarnessIcon(props: { node: TraceNodeFixture }) {
  if (!props.node.harness) return null;
  return <HarnessAvatar provider={props.node.harness} size={16} />;
}
