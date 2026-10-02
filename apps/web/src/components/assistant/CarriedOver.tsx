/**
 * The compacted summary a new chat opens with: still-open items, one line
 * each. Clicking an item opens it; the trace icon shows it in Trace.
 */
import { ListTreeIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ChatFixture } from "./assistantFixtures";
import { NodeGlyph, StatusLabel } from "./AssistantGlyphs";
import { delegationTarget, findDelegation } from "./assistantModel";
import { useOpenNode } from "./useOpenNode";

export function CarriedOver(props: { chat: ChatFixture; onTrace: (nodeId: string) => void }) {
  const openNode = useOpenNode();
  const items = props.chat.carriedOver.flatMap((item) => {
    const delegation = findDelegation(item.delegationId);
    const target = delegation ? delegationTarget(delegation) : undefined;
    return delegation && target ? [{ ...item, delegation, target }] : [];
  });
  if (items.length === 0) return null;
  return (
    <section
      aria-label="Carried over"
      className="flex flex-col gap-0.5 rounded-xl border border-dashed border-border p-1.5"
    >
      <h2 className="px-2 pt-1 pb-0.5 text-xs font-medium text-muted-foreground">Carried over</h2>
      <ul className="flex flex-col">
        {items.map(({ delegation, target, note }) => (
          <li key={delegation.id} className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => openNode(target)}
              className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
            >
              <NodeGlyph node={target} />
              <span className="shrink-0 font-medium">{target.name}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{note}</span>
              <StatusLabel status={delegation.status} waitingOn={delegation.waitingOn} />
            </button>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`Show ${target.name} in trace`}
                    onClick={() => props.onTrace(target.id)}
                  />
                }
              >
                <ListTreeIcon />
              </TooltipTrigger>
              <TooltipPopup>Show in trace</TooltipPopup>
            </Tooltip>
          </li>
        ))}
      </ul>
    </section>
  );
}
