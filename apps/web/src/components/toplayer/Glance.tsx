/**
 * The dashboard (issue #180): optional, never something you have to check.
 * Fully customizable from a default layout and a set of widgets; the assistant
 * can change it too, and its change is shown with an undo. Rows are
 * responsibilities, never chats, and each one opens its trace.
 */
import { Link } from "@tanstack/react-router";
import {
  ArrowDownIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  PencilIcon,
  PlusIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { useAssistantIdentity } from "../assistant/assistantIdentity";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { CALENDAR, CONTEXTS, DELIVERIES, READY } from "./topLayerFixtures";
import { useQueue } from "./topLayerHooks";
import { formatMinutes } from "./topLayerQueue";
import { useTopLayerStore, WIDGET_LABELS, type WidgetId } from "./topLayerStore";

const ALL_WIDGETS = Object.keys(WIDGET_LABELS) as WidgetId[];
const WIDE: ReadonlySet<WidgetId> = new Set(["responsibilities"]);

function KeepMoving(props: { onStart: () => void }) {
  const queue = useQueue();
  if (queue.turns.length === 0) {
    return <p className="text-sm text-foreground">Nothing needs you. Everything's moving.</p>;
  }
  return (
    <div className="flex items-center gap-3">
      <p className="min-w-0 flex-1 text-sm text-foreground">
        {formatMinutes(queue.minutes).replace(/^a/, "A")} to unblock{" "}
        {queue.turns.map((turn) => turn.context.name).join(", ")}
      </p>
      <Button size="sm" onClick={props.onStart}>
        Start
        <ArrowRightIcon />
      </Button>
    </div>
  );
}

function Responsibilities() {
  const queue = useQueue();
  const waiting = new Set(queue.turns.map((turn) => turn.context.id));
  return (
    <ul className="flex flex-col divide-y divide-border">
      {CONTEXTS.map((context) => (
        <li key={context.id}>
          <Link
            to="/agent/$agentId"
            params={{ agentId: context.agentId }}
            className="group flex flex-col gap-1.5 rounded-md py-2.5 focus-visible:outline-2 focus-visible:outline-ring"
          >
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-medium text-foreground group-hover:underline underline-offset-4">
                {context.name}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {waiting.has(context.id) ? "In your queue" : "Moving, needs nothing"}
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {context.progress}%
              </span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
              <div
                className="h-full rounded-full bg-foreground/55"
                style={{ width: `${context.progress}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">{context.progressNote}</p>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function SimpleList(props: { rows: ReadonlyArray<{ id: string; left: string; right: string }> }) {
  return (
    <ul className="flex flex-col gap-2">
      {props.rows.map((row) => (
        <li key={row.id} className="flex items-baseline gap-3 text-sm">
          <span className="min-w-0 flex-1 truncate text-foreground">{row.left}</span>
          <span className="shrink-0 text-muted-foreground tabular-nums">{row.right}</span>
        </li>
      ))}
    </ul>
  );
}

function widgetBody(id: WidgetId, onStart: () => void): ReactNode {
  switch (id) {
    case "keep-moving":
      return <KeepMoving onStart={onStart} />;
    case "responsibilities":
      return <Responsibilities />;
    case "deliveries":
      return (
        <SimpleList
          rows={DELIVERIES.map((item) => ({ id: item.id, left: item.label, right: item.status }))}
        />
      );
    case "calendar":
      return (
        <SimpleList
          rows={CALENDAR.map((item) => ({ id: item.id, left: item.label, right: item.time }))}
        />
      );
    case "ready":
      return (
        <SimpleList
          rows={READY.map((item) => ({
            id: item.id,
            left: item.title,
            right: item.summary.split(",")[0] ?? "",
          }))}
        />
      );
  }
}

function AskAssistant(props: { name: string }) {
  const [text, setText] = useState("");
  const widgets = useTopLayerStore((state) => state.widgets);
  const change = useTopLayerStore((state) => state.assistantChangeWidgets);

  // PLACEHOLDER for the assistant editing the layout from a request.
  const submit = () => {
    const request = text.trim().toLowerCase();
    if (!request) return;
    const named = ALL_WIDGETS.find((id) =>
      WIDGET_LABELS[id]
        .toLowerCase()
        .split(" ")
        .some((word) => word.length > 4 && request.includes(word)),
    );
    if (named && widgets.includes(named) && /remove|hide|drop|without/.test(request)) {
      change(
        widgets.filter((id) => id !== named),
        `${props.name} removed ${WIDGET_LABELS[named]}`,
      );
    } else {
      const add =
        named && !widgets.includes(named) ? named : ALL_WIDGETS.find((id) => !widgets.includes(id));
      if (add) change([...widgets, add], `${props.name} added ${WIDGET_LABELS[add]}`);
    }
    setText("");
  };

  return (
    <form
      className="flex gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Input
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={`Ask ${props.name} to change this, e.g. "add what's ready"`}
        aria-label={`Ask ${props.name} to change the dashboard`}
      />
      <Button type="submit" variant="outline" disabled={!text.trim()}>
        <SparklesIcon />
        Change
      </Button>
    </form>
  );
}

export function Glance(props: { onStart: () => void }) {
  const { name } = useAssistantIdentity();
  const widgets = useTopLayerStore((state) => state.widgets);
  const setWidgets = useTopLayerStore((state) => state.setWidgets);
  const dashboardChange = useTopLayerStore((state) => state.dashboardChange);
  const undo = useTopLayerStore((state) => state.undoDashboardChange);
  const [editing, setEditing] = useState(false);
  const hidden = ALL_WIDGETS.filter((id) => !widgets.includes(id));

  const move = (index: number, by: -1 | 1) => {
    const next = [...widgets];
    const [item] = next.splice(index, 1);
    if (item) next.splice(index + by, 0, item);
    setWidgets(next);
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 pt-8 pb-16">
      <div className="flex items-center gap-3">
        <h1 className="min-w-0 flex-1 text-xl font-semibold tracking-tight">Glance</h1>
        {editing && hidden.length > 0 ? (
          <Menu>
            <MenuTrigger render={<Button size="sm" variant="outline" />}>
              <PlusIcon />
              Add
            </MenuTrigger>
            <MenuPopup align="end">
              {hidden.map((id) => (
                <MenuItem key={id} onClick={() => setWidgets([...widgets, id])}>
                  {WIDGET_LABELS[id]}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        ) : null}
        <Button
          size="sm"
          variant={editing ? "default" : "ghost"}
          onClick={() => setEditing((on) => !on)}
        >
          {editing ? null : <PencilIcon />}
          {editing ? "Done" : "Customize"}
        </Button>
      </div>

      {dashboardChange ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <SparklesIcon className="size-3.5" />
          <span className="min-w-0 flex-1">{dashboardChange.text}</span>
          <Button size="xs" variant="ghost-muted" onClick={undo}>
            Undo
          </Button>
        </div>
      ) : null}

      {widgets.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          Nothing on your dashboard. Customize to add something, or ask {name}.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {widgets.map((id, index) => (
            <section
              key={id}
              aria-label={WIDGET_LABELS[id]}
              className={cn(
                "flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-xs/5",
                WIDE.has(id) && "sm:col-span-2",
              )}
            >
              <div className="flex items-center gap-1">
                <h2 className="min-w-0 flex-1 text-xs font-medium text-muted-foreground">
                  {WIDGET_LABELS[id]}
                </h2>
                {editing ? (
                  <>
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label="Move up"
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      <ArrowUpIcon />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label="Move down"
                      disabled={index === widgets.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <ArrowDownIcon />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost-destructive"
                      aria-label={`Remove ${WIDGET_LABELS[id]}`}
                      onClick={() => setWidgets(widgets.filter((other) => other !== id))}
                    >
                      <XIcon />
                    </Button>
                  </>
                ) : null}
              </div>
              {widgetBody(id, props.onStart)}
            </section>
          ))}
        </div>
      )}

      <AskAssistant name={name} />
    </div>
  );
}
