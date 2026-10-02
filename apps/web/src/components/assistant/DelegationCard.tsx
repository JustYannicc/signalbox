/**
 * One hand-off in a chat. Collapsed it is a single line: what went to whom and
 * its Pipeline status. Progress, route and the exact message are one click
 * down. Only an approval waiting on the user stays visible without expanding.
 */
import { ArrowUpRightIcon, ChevronDownIcon, ChevronRightIcon, ListTreeIcon } from "lucide-react";
import { Fragment } from "react";

import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { DelegationFixture } from "./assistantFixtures";
import { HarnessIcon, NodeGlyph, NodeName, StatusLabel } from "./AssistantGlyphs";
import { delegationTarget, describeTarget, findNode } from "./assistantModel";
import { setLocalStatus } from "./mockChatStore";
import { useOpenNode } from "./useOpenNode";

/** PLACEHOLDER: flips the hand-off locally; Approve lets it carry on, Not now holds it. */
const answerApproval = (delegationId: string, approved: boolean) =>
  setLocalStatus(delegationId, approved ? "working" : "input");

export function DelegationCard(props: {
  delegation: DelegationFixture;
  /** The chat's own node; route hops up to and including it are left out. */
  fromNodeId?: string;
  onTrace: (nodeId: string) => void;
}) {
  const { delegation } = props;
  const openNode = useOpenNode();
  const target = delegationTarget(delegation);
  if (!target) return null;
  const start = delegation.hops.findIndex((hop) => hop.to === props.fromNodeId) + 1;
  const route = delegation.hops.slice(start, -1).flatMap((hop) => {
    const node = findNode(hop.to);
    return node ? [node] : [];
  });

  return (
    <article
      aria-label={`Handed to ${target.name}`}
      className="rounded-xl border border-border text-card-foreground"
    >
      <Collapsible>
        <CollapsibleTrigger className="group/card flex w-full min-w-0 items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring">
          <NodeGlyph node={target} />
          <span className="min-w-0 flex-1 truncate">
            <span className="text-muted-foreground">Asked </span>
            <span className="font-medium">{target.name}</span>
            <span className="text-muted-foreground"> to </span>
            {delegation.summary}
          </span>
          <StatusLabel status={delegation.status} waitingOn={delegation.waitingOn} />
          <ChevronDownIcon
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-panel-open/card:rotate-180"
          />
        </CollapsibleTrigger>

        <CollapsiblePanel>
          <div className="flex flex-col gap-2.5 px-3 pt-1 pb-3">
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
              <StatusLabel status={delegation.status} waitingOn={delegation.waitingOn} full />
              <span className="text-muted-foreground">· {delegation.statusDetail}</span>
            </p>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted-foreground">
              <HarnessIcon node={target} />
              <span>{describeTarget(target)}</span>
              {route.length > 0 ? (
                <span className="flex min-w-0 items-center gap-1">
                  via
                  {route.map((node, index) => (
                    <Fragment key={node.id}>
                      {index > 0 ? <ChevronRightIcon aria-hidden className="size-3" /> : null}
                      <span className="text-foreground">
                        <NodeName node={node} />
                      </span>
                    </Fragment>
                  ))}
                </span>
              ) : null}
              <span className="tabular-nums">{delegation.at}</span>
            </div>
            <p className="rounded-lg bg-muted px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap">
              {delegation.message}
            </p>
            <div className="flex items-center gap-1">
              <Button size="xs" variant="outline" onClick={() => openNode(target)}>
                Open
                <ArrowUpRightIcon />
              </Button>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label="Show in trace"
                      onClick={() => props.onTrace(target.id)}
                    />
                  }
                >
                  <ListTreeIcon />
                </TooltipTrigger>
                <TooltipPopup>Show in trace</TooltipPopup>
              </Tooltip>
            </div>
          </div>
        </CollapsiblePanel>
      </Collapsible>

      {delegation.status === "approval" && delegation.approval ? (
        <div className="flex flex-col gap-2.5 border-t border-border px-3 py-3">
          <p className="text-sm font-medium">{delegation.approval.question}</p>
          <code className="block overflow-x-auto rounded-lg bg-muted px-3 py-2 font-mono text-xs whitespace-nowrap">
            {delegation.approval.command}
          </code>
          <div className="flex items-center gap-2">
            <Button size="xs" onClick={() => answerApproval(delegation.id, true)}>
              Approve
            </Button>
            <Button size="xs" variant="ghost" onClick={() => answerApproval(delegation.id, false)}>
              Not now
            </Button>
          </div>
        </div>
      ) : null}
    </article>
  );
}
