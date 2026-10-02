/** What the setup prompt has the agent do, in order. Statusless until setup can report progress. */
import { SETUP_STEPS } from "./setupFixtures";

export function SetupChecklist() {
  return (
    <section aria-labelledby="setup-steps" className="flex flex-col gap-3">
      <h2 id="setup-steps" className="text-sm font-medium text-foreground">
        What your agent will do
      </h2>
      <ol className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {SETUP_STEPS.map((step, index) => (
          <li key={step.id} className="flex items-baseline gap-3 px-4 py-2.5">
            <span className="w-4 shrink-0 text-xs text-muted-foreground tabular-nums">
              {index + 1}
            </span>
            <span className="text-sm text-foreground">{step.label}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {step.detail}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
