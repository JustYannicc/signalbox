/**
 * "Add a step": every step and trigger an automation can use, searchable, as
 * the start of a request to an agent. Picking one opens a new thread in the
 * automation's project with the request in its composer; the agent changes
 * the code and the diagram follows. Nothing is inserted here.
 */
import type { Automation, EnvironmentId } from "@t3tools/contracts";
import { addStepPrompt, addTriggerPrompt } from "@t3tools/client-runtime/automations/prompts";
import { Link } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { createElement, useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { filterCatalog, STEP_GROUPS, TRIGGER_GROUP, type CatalogEntry } from "./stepCatalog";
import { useAutomationAgent } from "./useAutomationAgent";

const ADDABLE_GROUPS = [
  ...STEP_GROUPS,
  { ...TRIGGER_GROUP, entries: TRIGGER_GROUP.entries.filter((entry) => entry.id !== "manual") },
];

function EntryRow(props: { entry: CatalogEntry; onPick: (entry: CatalogEntry) => void }) {
  const { entry } = props;
  return (
    <li>
      <button
        type="button"
        onClick={() => props.onPick(entry)}
        className="flex w-full cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:bg-accent"
      >
        {createElement(entry.icon, {
          "aria-hidden": true,
          className: "mt-0.5 size-4 shrink-0 text-muted-foreground",
        })}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-baseline gap-1.5 text-sm text-foreground">
            <span className="truncate">{entry.label}</span>
            <code className="shrink-0 font-mono text-2xs text-muted-foreground">{entry.code}</code>
          </span>
          <span className="text-xs text-pretty text-muted-foreground">{entry.description}</span>
        </span>
      </button>
    </li>
  );
}

export function AddStepPalette(props: {
  environmentId: EnvironmentId;
  automation: Pick<Automation, "id" | "name" | "projectId">;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const askAgent = useAutomationAgent(props.environmentId, props.automation);
  const groups = filterCatalog(ADDABLE_GROUPS, query);

  const pick = (entry: CatalogEntry) => {
    setOpen(false);
    void askAgent(
      entry.kind === "trigger"
        ? addTriggerPrompt(props.automation, entry.label)
        : addStepPrompt(props.automation, entry.label),
    );
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger
        render={
          <Button size="xs" variant="outline">
            <PlusIcon />
            Add a step
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
            {groups.length === 0 ? (
              <p className="px-2 py-6 text-center text-sm text-pretty text-muted-foreground">
                Nothing matches. A Run step can do anything Node can.
              </p>
            ) : null}
            {groups.map((group) => (
              <section key={group.title} className="flex flex-col">
                <h3 className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                  {group.title}
                </h3>
                <ul className="flex flex-col">
                  {group.entries.map((entry) => (
                    <EntryRow key={entry.id} entry={entry} onPick={pick} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
          <div className="border-t px-3 py-2 text-xs text-muted-foreground">
            An agent adds it in a new thread; tell it what the step should do.{" "}
            <Link
              to="/automations"
              search={{ view: "steps" }}
              className="underline-offset-2 hover:text-foreground hover:underline"
            >
              All steps
            </Link>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
