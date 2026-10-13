/**
 * What one audience at a level actually reads on one harness: the files that
 * reach it from above, then its own, each labelled with its level. Blocks a
 * nearer level overrides (same heading) are listed instead of shown.
 */
import { useLevelAgentName, useLevelLabel } from "../levels/LevelOptionsProvider";
import type { LevelKey } from "../levels/levels";
import { Badge } from "../ui/badge";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  instructionFileName,
  sourceText,
  type InstructionAudience,
  type LevelInstructions,
} from "./instructionsModel";
import { useResolvedInstructions } from "./instructionsStore";
import { HARNESSES, type HarnessId } from "./pluginsModel";
import { HarnessGlyph } from "./pluginsPrimitives";

function firstLine(text: string) {
  return text.trim().split("\n", 1)[0] ?? "";
}

export function InstructionsPreview(props: {
  level: LevelKey;
  audience: InstructionAudience;
  harness: HarnessId;
  onHarnessChange: (harness: HarnessId) => void;
  /** Unsaved edits to show in place of the level's saved file. */
  draft?: LevelInstructions | undefined;
}) {
  const sources = useResolvedInstructions(props.level, props.audience, props.harness, props.draft);
  const levelLabel = useLevelLabel();
  const agentName = useLevelAgentName();
  const harnessName = HARNESSES.find((entry) => entry.id === props.harness)?.label ?? "";
  const reader = props.audience === "agent" ? agentName(props.level) : "a thread here";

  return (
    <section className="flex min-w-0 flex-col gap-2">
      <div className="flex min-h-7 flex-wrap items-center gap-1 px-1">
        <h3 className="me-1 text-sm text-foreground/70">What {reader} reads on</h3>
        <Select
          value={props.harness}
          onValueChange={(value) => {
            const next = HARNESSES.find((entry) => entry.id === value);
            if (next) props.onHarnessChange(next.id);
          }}
        >
          <SelectTrigger size="xs" variant="ghost" aria-label="Preview on harness">
            <SelectValue>
              <span className="flex items-center gap-1.5">
                <HarnessGlyph harness={props.harness} />
                {harnessName}
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
      {sources.length === 0 ? (
        <p className="rounded-xl border border-border/60 bg-muted/40 p-4 text-sm text-muted-foreground">
          Nothing reaches {reader} on {harnessName} yet.
        </p>
      ) : (
        <ol className="flex flex-col gap-3">
          {sources.map((source) => {
            const text = sourceText(source);
            const overridden = source.blocks.filter((entry) => entry.overriddenBy !== null);
            return (
              <li key={source.level} className="flex min-w-0 flex-col gap-1.5">
                <div className="flex min-w-0 items-center gap-2 px-1">
                  <span className="truncate text-xs font-medium text-foreground">
                    {levelLabel(source.level)}
                  </span>
                  <Badge variant={source.inherited ? "outline" : "secondary"} size="sm">
                    {source.inherited ? "Inherited" : "This level"}
                  </Badge>
                </div>
                {text ? (
                  <pre className="overflow-auto rounded-xl border border-border/60 bg-muted/40 p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-foreground">
                    {text}
                  </pre>
                ) : null}
                {overridden.map((entry) => (
                  <p key={entry.block.id} className="px-1 text-xs text-muted-foreground">
                    <span className="font-mono">{firstLine(entry.block.text)}</span> overridden by{" "}
                    {levelLabel(entry.overriddenBy ?? source.level)}
                  </p>
                ))}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
