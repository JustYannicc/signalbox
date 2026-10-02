/**
 * "Preview as": the compiled instruction file one role on one harness
 * receives, across every scope.
 */
import { useAssistantIdentity } from "../assistant/assistantIdentity";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  compileInstructions,
  instructionFileName,
  INSTRUCTION_ROLES,
  ROLE_INFO,
  roleLabel,
  type InstructionBlock,
  type InstructionRole,
  type InstructionScope,
} from "./instructionsModel";
import { HARNESSES, type HarnessId } from "./pluginsModel";
import { HarnessGlyph } from "./pluginsPrimitives";

export function InstructionsPreview(props: {
  role: InstructionRole;
  onRoleChange: (role: InstructionRole) => void;
  harness: HarnessId;
  onHarnessChange: (harness: HarnessId) => void;
  blocksIn: (role: InstructionRole, scope: InstructionScope) => readonly InstructionBlock[];
}) {
  const compiled = compileInstructions(
    (scope) => props.blocksIn(props.role, scope),
    props.role,
    props.harness,
  );
  const harnessLabel = HARNESSES.find((entry) => entry.id === props.harness)?.label ?? "";
  const { name } = useAssistantIdentity();
  const label = roleLabel(props.role, name);

  return (
    <section className="flex min-w-0 flex-col gap-2 lg:sticky lg:top-4 lg:self-start">
      <div className="flex min-h-7 flex-wrap items-center gap-1 px-1">
        <h3 className="me-1 text-sm text-foreground/70">Preview as</h3>
        <Select
          value={props.role}
          onValueChange={(value) => {
            const next = INSTRUCTION_ROLES.find((role) => role === value);
            if (next) props.onRoleChange(next);
          }}
        >
          <SelectTrigger size="xs" variant="ghost" aria-label="Preview as role">
            <SelectValue>{label}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="start" alignItemWithTrigger={false}>
            {INSTRUCTION_ROLES.map((role) => (
              <SelectItem key={role} value={role}>
                {roleLabel(role, name)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <span className="text-xs text-muted-foreground">on</span>
        <Select
          value={props.harness}
          onValueChange={(value) => {
            const next = HARNESSES.find((entry) => entry.id === value);
            if (next) props.onHarnessChange(next.id);
          }}
        >
          <SelectTrigger size="xs" variant="ghost" aria-label="Preview as harness">
            <SelectValue>
              <span className="flex items-center gap-1.5">
                <HarnessGlyph harness={props.harness} />
                {harnessLabel}
              </span>
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="start" alignItemWithTrigger={false}>
            {HARNESSES.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                <span className="flex items-center gap-2">
                  <HarnessGlyph harness={entry.id} />
                  {entry.label}
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <span className="ms-auto font-mono text-xs text-muted-foreground">
          {instructionFileName(props.harness)}
        </span>
      </div>
      <pre className="max-h-160 min-h-40 overflow-auto rounded-xl border border-border/60 bg-muted/40 p-4 font-mono text-xs leading-5 whitespace-pre-wrap text-foreground">
        {compiled || `${label} on ${harnessLabel} gets no instructions.`}
      </pre>
      <p className="px-1 text-xs text-muted-foreground">
        {ROLE_INFO[props.role].supervisor
          ? "Supervisors only read your personal files."
          : "In merchant-portal, under the Northwind group."}
      </p>
    </section>
  );
}
