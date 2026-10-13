/**
 * Details-panel sections only some node kinds have, rendered after
 * Configuration: what a handoff lets cross the boundary, and the corrections
 * that shape an approval's future drafts.
 */
import { CheckIcon, XIcon } from "lucide-react";

import type { WorkflowNodeConfig } from "./automationModel";
import { Field, Note, Section } from "./nodeDetailsParts";
import { useAssistantName } from "./useAssistantName";

function ScopeList(props: { items: readonly string[]; allowed: boolean }) {
  const Icon = props.allowed ? CheckIcon : XIcon;
  return (
    <ul className="flex flex-col gap-1.5">
      {props.items.map((item) => (
        <li key={item} className="flex items-start gap-2 text-sm text-foreground">
          <Icon
            aria-hidden
            className={
              props.allowed
                ? "mt-0.5 size-3.5 shrink-0 text-success-foreground"
                : "mt-0.5 size-3.5 shrink-0 text-muted-foreground"
            }
          />
          {item}
        </li>
      ))}
    </ul>
  );
}

function formatCorrectionDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Sections only some node kinds have, rendered after Configuration. */
export function NodeExtraSections({ config }: { config: WorkflowNodeConfig }) {
  const nameText = useAssistantName();
  if (config.kind === "handoff") {
    return (
      <Section title="Scope">
        <Note>{nameText(config.scopeNote)}</Note>
        <Field label="Shares">
          <ScopeList items={config.shares} allowed />
        </Field>
        <Field label="Never shares">
          <ScopeList items={config.withheld} allowed={false} />
        </Field>
      </Section>
    );
  }
  if (config.kind === "approval") {
    return (
      <Section title="Correction history">
        <Note>
          Corrections from the owner update future handling. When {config.approver} edits a draft
          before approving it, the difference is saved and every later draft follows it.
        </Note>
        {config.corrections.length === 0 ? (
          <p className="text-sm text-muted-foreground">No corrections yet.</p>
        ) : (
          <ol className="flex flex-col gap-3">
            {config.corrections.map((correction) => (
              <li key={correction.at} className="flex flex-col gap-0.5">
                <span className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
                  <span className="min-w-0 truncate">{correction.subject}</span>
                  <span className="shrink-0 tabular-nums">
                    {formatCorrectionDate(correction.at)}
                  </span>
                </span>
                <span className="text-sm text-foreground">{correction.note}</span>
              </li>
            ))}
          </ol>
        )}
      </Section>
    );
  }
  return null;
}
