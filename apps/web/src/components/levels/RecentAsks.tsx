/**
 * Recent asks an agent made or answered (`askUp.ts`), for the Access popover.
 * Each shows its outcome: access lent for the task (temporary, endable early),
 * or the work done above with only the answer handed down. Render inside a
 * `LevelOptionsProvider` so agent names resolve.
 */
import { Link } from "@tanstack/react-router";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { asksFor, loanState, useAskUpStore, type AskUp } from "./askUp";
import type { LevelKey } from "./levels";
import { useLevelAgentName } from "./LevelOptionsProvider";

function endLoan(ask: AskUp, lent: string) {
  const { setEnded } = useAskUpStore.getState();
  setEnded(ask.id, true);
  toastManager.add({
    id: `ask-up-end-${ask.id}`,
    type: "success",
    title: `Ended access to ${lent}`,
    timeout: 5000,
    actionProps: { children: "Undo", onClick: () => setEnded(ask.id, false) },
  });
}

function TaskName(props: { task: AskUp["task"] }) {
  const { task } = props;
  if (!task.threadId) return <span className="text-foreground">{task.title}</span>;
  return (
    <Link
      to="/shared/$threadId"
      params={{ threadId: task.threadId }}
      className="text-foreground underline-offset-4 hover:underline"
    >
      {task.title}
    </Link>
  );
}

function Outcome(props: { ask: AskUp; answerer: string }) {
  const { ask } = props;
  const endedEarly = useAskUpStore((state) => state.ended[ask.id] === true);
  if (ask.outcome.kind === "answered") {
    return (
      <div className="flex flex-col gap-0.5">
        <span className="flex items-start gap-1.5">
          <Badge variant="info" size="sm">
            Did the work
          </Badge>
          <span className="text-muted-foreground text-pretty">
            Handed back only: {ask.outcome.handedBack}
          </span>
        </span>
        <span className="text-xs text-muted-foreground text-pretty">
          Kept {ask.outcome.kept} with {props.answerer}. {ask.outcome.why}
        </span>
      </div>
    );
  }
  const { lent } = ask.outcome;
  const state = loanState(ask, endedEarly);
  return (
    <div className="flex items-center gap-1.5">
      <Badge variant={state === "active" ? "warning" : "secondary"} size="sm">
        {state === "active" ? "Lent" : "Ended"}
      </Badge>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {lent} ·{" "}
        {state === "active"
          ? "until the task ends"
          : state === "expired"
            ? "ended with the task"
            : "you ended it"}
      </span>
      {state === "active" ? (
        <Button size="xs" variant="ghost" onClick={() => endLoan(ask, lent)}>
          End now
        </Button>
      ) : null}
    </div>
  );
}

export function RecentAsks(props: { level: LevelKey }) {
  const agentName = useLevelAgentName();
  const asks = asksFor(props.level);
  if (asks.length === 0) return null;
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">Recent asks</h3>
      <ul className="flex flex-col gap-2.5">
        {asks.map((ask) => (
          <li key={ask.id} className="flex flex-col gap-1">
            <span className="flex items-baseline gap-1.5">
              <span className="min-w-0 truncate">
                <span className="text-foreground">{agentName(ask.from)}</span>
                <span className="text-muted-foreground"> asked </span>
                <span className="text-foreground">{agentName(ask.to)}</span>
              </span>
              <span className="ms-auto shrink-0 text-xs text-muted-foreground">{ask.at}</span>
            </span>
            <span className="text-muted-foreground text-pretty">
              “{ask.asked}” for <TaskName task={ask.task} />
            </span>
            <Outcome ask={ask} answerer={agentName(ask.to)} />
          </li>
        ))}
      </ul>
    </section>
  );
}
