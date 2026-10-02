/**
 * Trace: every hand-off in the chat as trees, one per origin (the assistant, or
 * an automation's trigger). Picking a node shows each hop that reached it, what
 * the receiving thread saw, and the notification decisions made about it.
 */
import { ArrowRightIcon, CornerDownRightIcon, ListTreeIcon, XIcon } from "lucide-react";
import { useEffect, useMemo } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import type { DelegationFixture } from "./assistantFixtures";
import { HarnessIcon, NodeGlyph, NodeName, StatusIcon, StatusLabel } from "./AssistantGlyphs";
import { useAssistantIdentity } from "./assistantIdentity";
import {
  buildTraceForest,
  describeTarget,
  findNode,
  hopsReaching,
  type TraceTreeNode,
} from "./assistantModel";
import { canOpenNode, useOpenNode } from "./useOpenNode";
import {
  DELIVERY_ICON,
  deliveryLabel,
  NotificationRow,
  type NotificationDecision,
} from "./NotificationRow";

type NoticesByNode = ReadonlyMap<string, readonly NotificationDecision[]>;

function groupNotices(notices: readonly NotificationDecision[]): NoticesByNode {
  const byNode = new Map<string, NotificationDecision[]>();
  for (const notice of notices) {
    byNode.set(notice.nodeId, [...(byNode.get(notice.nodeId) ?? []), notice]);
  }
  return byNode;
}

/** A tiny mark on nodes with notification decisions: the loudest delivery wins. */
function NoticeMark(props: { notices: readonly NotificationDecision[] | undefined }) {
  if (!props.notices?.length) return null;
  const deliveries = new Set(props.notices.map((notice) => notice.delivery));
  const loudest = deliveries.has("phone")
    ? "phone"
    : deliveries.has("computer")
      ? "computer"
      : "none";
  const Icon = DELIVERY_ICON[loudest];
  return (
    <Icon
      role="img"
      aria-label={deliveryLabel(loudest)}
      className="size-3 shrink-0 text-muted-foreground"
    />
  );
}

function TreeBranch(props: {
  tree: TraceTreeNode;
  selectedId: string | null;
  notices: NoticesByNode;
  onSelect: (nodeId: string) => void;
}) {
  const { tree } = props;
  const selected = tree.node.id === props.selectedId;
  return (
    <li className="flex flex-col">
      <button
        type="button"
        aria-current={selected || undefined}
        onClick={() => props.onSelect(tree.node.id)}
        className={cn(
          "flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring",
          selected && "bg-accent",
        )}
      >
        <NodeGlyph node={tree.node} />
        <span className="min-w-0 flex-1 truncate">
          <NodeName node={tree.node} />
        </span>
        <NoticeMark notices={props.notices.get(tree.node.id)} />
        {tree.status ? <StatusIcon status={tree.status} waitingOn={tree.waitingOn} /> : null}
      </button>
      {tree.children.length > 0 ? (
        <ul className="ms-3.5 flex flex-col gap-0.5 border-s border-border ps-1.5 pt-0.5">
          {tree.children.map((child) => (
            <TreeBranch
              key={child.node.id}
              tree={child}
              selectedId={props.selectedId}
              notices={props.notices}
              onSelect={props.onSelect}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function NodeDetail(props: {
  nodeId: string;
  delegations: readonly DelegationFixture[];
  notices: readonly NotificationDecision[] | undefined;
}) {
  const { name: assistantName } = useAssistantIdentity();
  const node = findNode(props.nodeId);
  if (!node) return null;
  if (node.kind === "assistant") {
    return (
      <p className="text-sm text-muted-foreground">
        {assistantName} answers quick questions itself and hands real work to the agent that owns
        it. Pick a node to see what it was asked.
      </p>
    );
  }
  const chains = hopsReaching(node.id, props.delegations);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <h2 className="flex items-center gap-2 text-base font-semibold text-balance">
          <NodeGlyph node={node} />
          {node.name}
        </h2>
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <HarnessIcon node={node} />
          {describeTarget(node)}
        </p>
      </div>

      {props.notices?.length ? (
        <section className="flex flex-col gap-1">
          <h3 className="text-xs font-medium text-muted-foreground">Notifications</h3>
          <div className="-mx-2 flex flex-col">
            {props.notices.map((notice) => (
              <NotificationRow
                key={`${notice.at}:${notice.reason}`}
                notice={notice}
                at={notice.at}
              />
            ))}
          </div>
        </section>
      ) : null}

      {chains.map(({ delegation, hops }) => {
        const last = hops.at(-1);
        return (
          <section key={delegation.id} className="flex flex-col gap-3">
            <h3 className="text-xs font-medium text-muted-foreground">
              Route for “{delegation.summary}”
            </h3>
            <ol className="flex flex-col gap-3">
              {hops.map(({ from, to, hop }) => (
                <li key={to.id} className="flex flex-col gap-1.5">
                  <p className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="font-medium">
                      <NodeName node={from} />
                    </span>
                    <ArrowRightIcon aria-hidden className="size-3 text-muted-foreground" />
                    <span className="font-medium">{to.name}</span>
                    <span className="text-muted-foreground tabular-nums">· {hop.at}</span>
                    <span className="ms-auto">
                      <StatusLabel
                        status={hop.status}
                        waitingOn={to.id === node.id ? delegation.waitingOn : undefined}
                        full
                      />
                    </span>
                  </p>
                  <p className="rounded-lg bg-muted px-3 py-2 text-sm leading-relaxed">
                    {hop.message}
                  </p>
                </li>
              ))}
            </ol>
            {node.kind === "thread" && last ? (
              <div className="flex flex-col gap-2">
                <h3 className="text-xs font-medium text-muted-foreground">In the thread</h3>
                <div className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2.5">
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <CornerDownRightIcon aria-hidden className="size-3" />
                    Delegated by
                    <NodeGlyph node={last.from} />
                    <span className="font-medium text-foreground">
                      <NodeName node={last.from} />
                    </span>
                    <span className="tabular-nums">· {last.hop.at}</span>
                  </p>
                  <p className="text-sm leading-relaxed">{last.hop.message}</p>
                </div>
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

export function AssistantTracePanel(props: {
  delegations: readonly DelegationFixture[];
  /** Notification decisions from the chat, shown on the node they were about. */
  notifications: readonly NotificationDecision[];
  selectedNodeId: string | null;
  onSelect: (nodeId: string) => void;
  onClose: () => void;
}) {
  const { onClose } = props;
  const forest = buildTraceForest(props.delegations);
  const openNode = useOpenNode();
  const notices = useMemo(() => groupNotices(props.notifications), [props.notifications]);
  const selected = props.selectedNodeId ? findNode(props.selectedNodeId) : undefined;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <aside
      aria-label="Trace"
      className="flex w-80 shrink-0 flex-col border-l border-border bg-background max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-10 max-lg:shadow-lg xl:w-96"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border pr-2 pl-4">
        <ListTreeIcon aria-hidden className="size-3.5 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
          Trace
        </span>
        <Button size="icon-xs" variant="ghost-muted" aria-label="Close trace" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-5 p-3">
          {forest.length > 0 ? (
            <ul aria-label="Hand-offs" className="flex flex-col gap-2">
              {forest.map((tree) => (
                <TreeBranch
                  key={tree.node.id}
                  tree={tree}
                  selectedId={props.selectedNodeId}
                  notices={notices}
                  onSelect={props.onSelect}
                />
              ))}
            </ul>
          ) : (
            <p className="px-1 text-sm text-muted-foreground">Nothing handed off in this chat.</p>
          )}
          <div className="border-t border-border px-1 pt-4">
            {props.selectedNodeId ? (
              <NodeDetail
                nodeId={props.selectedNodeId}
                delegations={props.delegations}
                notices={notices.get(props.selectedNodeId)}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                Pick a node to see what it was asked and by whom.
              </p>
            )}
          </div>
        </div>
      </ScrollArea>
      {selected && selected.kind !== "assistant" && canOpenNode(selected) ? (
        <div className="flex shrink-0 flex-col border-t border-border p-3">
          <Button variant="outline" onClick={() => openNode(selected)}>
            Open
          </Button>
        </div>
      ) : null}
    </aside>
  );
}
