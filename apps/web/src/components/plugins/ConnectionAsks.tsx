/**
 * Recent asks for a connection from agents that can't use it themselves
 * (`levels/askUp.ts`): lent for one task, or kept above with only the answer
 * handed down. Shown in a connection's panel so you see where it travelled.
 * PLACEHOLDER: asks name the thing by display name; real asks will carry its key.
 */
import { Badge } from "../ui/badge";
import { ASK_UPS, type AskUp } from "../levels/askUp";
import { useLevelAgentName } from "../levels/LevelOptionsProvider";
import { connectionDisplayName, type Integration } from "./pluginsModel";

const askedThing = (ask: AskUp) =>
  ask.outcome.kind === "lent" ? ask.outcome.lent : ask.outcome.kept;

export function asksForIntegration(integration: Integration): readonly AskUp[] {
  const names = integration.accounts.map((account) =>
    connectionDisplayName(integration, account.label),
  );
  return ASK_UPS.filter((ask) => names.some((name) => askedThing(ask).startsWith(name)));
}

export function ConnectionAsks(props: { integration: Integration }) {
  const agentName = useLevelAgentName();
  const asks = asksForIntegration(props.integration);
  if (asks.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <h4 className="text-xs font-medium text-muted-foreground">Asked for from other levels</h4>
      <ul className="flex flex-col divide-y divide-border/40 rounded-lg border border-border/50 bg-background">
        {asks.map((ask) => (
          <li key={ask.id} className="flex flex-col gap-0.5 px-3 py-2 text-xs">
            <span className="flex flex-wrap items-center gap-1.5">
              <Badge variant={ask.outcome.kind === "lent" ? "outline" : "info"} size="sm">
                {ask.outcome.kind === "lent" ? "Lent for the task" : "Kept, answered"}
              </Badge>
              <span className="text-foreground">
                {agentName(ask.from)} for “{ask.task.title}”
              </span>
              <span className="text-muted-foreground">· {ask.at}</span>
            </span>
            <span className="text-muted-foreground text-pretty">
              {ask.outcome.kind === "lent"
                ? `${agentName(ask.to)} lent ${ask.outcome.lent}${ask.task.done ? "; the task is done, so the loan ended." : " until the task ends."}`
                : `${agentName(ask.to)} handed back only: ${ask.outcome.handedBack}.`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
