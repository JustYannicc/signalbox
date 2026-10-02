/**
 * "Ask agent to add…": every step and trigger primitive, grouped and
 * searchable, as prompt starters. Picking one opens the workflow agent with
 * the request; the agent changes the source and the graph follows. Nothing is
 * inserted here.
 */
import { Link } from "@tanstack/react-router";
import { SparklesIcon } from "lucide-react";
import { createElement, useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import type { Automation } from "./automationModel";
import {
  HOOK_GROUPS,
  STEP_GROUPS,
  filterGroups,
  type HookPrimitive,
  type StepPrimitive,
} from "./primitiveCatalog";
import { useOpenWorkflowAgent } from "./WorkflowAgent";

/** Opens the workflow agent with the request prefilled in its composer. */
function useAskAgentToAdd(automation: Automation) {
  const openAgent = useOpenWorkflowAgent();
  return (label: string) =>
    openAgent(automation, `Add a "${label}" step to ${automation.name}. Ask me what it should do.`);
}

function PrimitiveRow(props: {
  item: StepPrimitive | HookPrimitive;
  onPick: (label: string) => void;
}) {
  const { item } = props;
  return (
    <li>
      <button
        type="button"
        onClick={() => props.onPick(item.label)}
        className="flex w-full cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:bg-accent"
      >
        {createElement(item.icon, {
          "aria-hidden": true,
          className: "mt-0.5 size-4 shrink-0 text-muted-foreground",
        })}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-1.5 text-sm text-foreground">
            <span className="truncate">{item.label}</span>
            {"mode" in item && item.mode === "inline" ? (
              <Badge variant="warning" size="sm">
                Inline
              </Badge>
            ) : null}
          </span>
          <span className="text-xs text-pretty text-muted-foreground">{item.description}</span>
        </span>
      </button>
    </li>
  );
}

function Group(props: {
  title: string;
  items: readonly (StepPrimitive | HookPrimitive)[];
  onPick: (label: string) => void;
}) {
  return (
    <section className="flex flex-col gap-0.5">
      <h3 className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">{props.title}</h3>
      <ul className="flex flex-col">
        {props.items.map((item) => (
          <PrimitiveRow key={item.id} item={item} onPick={props.onPick} />
        ))}
      </ul>
    </section>
  );
}

export function AddStepPalette(props: { automation: Automation }) {
  const [query, setQuery] = useState("");
  const askToAdd = useAskAgentToAdd(props.automation);
  const steps = filterGroups(STEP_GROUPS, query);
  const hooks = filterGroups(HOOK_GROUPS, query);
  const empty = steps.length === 0 && hooks.length === 0;

  return (
    <Popover onOpenChange={(open) => (open ? undefined : setQuery(""))}>
      <PopoverTrigger
        render={
          <Button size="xs" variant="outline">
            <SparklesIcon />
            Ask agent to add…
          </Button>
        }
      />
      <PopoverPopup side="bottom" align="start" padding="none" width="lg">
        <div className="flex max-h-[min(32rem,70vh)] flex-col">
          <div className="border-b p-2">
            <Input
              nativeInput
              autoFocus
              type="search"
              size="sm"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search steps and triggers"
              aria-label="Search steps and triggers"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1">
            {empty ? (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                Nothing matches. A code step can do anything TypeScript can.
              </p>
            ) : null}
            {steps.map((group) => (
              <Group key={group.title} title={group.title} items={group.items} onPick={askToAdd} />
            ))}
            {hooks.length > 0 ? (
              <h3 className="px-2 pt-3 pb-0.5 text-xs font-semibold text-foreground">Triggers</h3>
            ) : null}
            {hooks.map((group) => (
              <Group key={group.title} title={group.title} items={group.items} onPick={askToAdd} />
            ))}
          </div>
          <div className="border-t px-3 py-2 text-xs text-muted-foreground">
            <Link
              to="/automations"
              search={{ view: "primitives" }}
              className="underline-offset-2 hover:text-foreground hover:underline"
            >
              Everything a workflow can hook into
            </Link>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
