/**
 * The Steps view of `/automations`: every trigger and step an automation can
 * use, with how it's written in the code. Same list as the canvas's add-step
 * palette.
 */
import { createElement } from "react";

import { STEP_GROUPS, TRIGGER_GROUP, type CatalogGroup } from "./stepCatalog";

function Group(props: { group: CatalogGroup }) {
  return (
    <section className="flex flex-col">
      <h3 className="text-xs font-medium text-muted-foreground">{props.group.title}</h3>
      <ul className="flex flex-col divide-y">
        {props.group.entries.map((entry) => (
          <li key={entry.id} className="flex items-start gap-3 py-2.5">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              {createElement(entry.icon, { "aria-hidden": true, className: "size-3.5" })}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm font-medium text-foreground">{entry.label}</span>
              <span className="text-sm text-pretty text-muted-foreground">{entry.description}</span>
            </div>
            <code className="hidden shrink-0 pt-0.5 font-mono text-xs text-muted-foreground sm:block">
              {entry.code}
            </code>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function StepsReference() {
  return (
    <div className="flex flex-col gap-10">
      <p className="text-sm text-pretty text-muted-foreground">
        An automation is one TypeScript file built from these. You don't write it yourself: ask an
        agent, and it picks the steps.
      </p>
      <section aria-labelledby="steps-triggers" className="flex flex-col gap-5">
        <h2 id="steps-triggers" className="text-base font-semibold text-foreground">
          Triggers
        </h2>
        <Group group={TRIGGER_GROUP} />
      </section>
      <section aria-labelledby="steps-steps" className="flex flex-col gap-5">
        <h2 id="steps-steps" className="text-base font-semibold text-foreground">
          Steps
        </h2>
        {STEP_GROUPS.map((group) => (
          <Group key={group.title} group={group} />
        ))}
      </section>
    </div>
  );
}
