/**
 * One AGENTS.md block: a colored gutter for which harness reads it, the
 * harness picker, and the markdown itself.
 */
import { Trash2Icon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { harnessLabel, type InstructionHarness, type InstructionBlock } from "./instructionsModel";
import { HARNESSES } from "./pluginsModel";
import { HarnessGlyph } from "./pluginsPrimitives";

/** Gutter color per harness. Blocks for everyone stay neutral so harness-only ones stand out. */
export const HARNESS_RAIL: Record<InstructionHarness, string> = {
  all: "bg-border",
  claudeAgent: "bg-warning",
  codex: "bg-foreground",
  cursor: "bg-info",
  grok: "bg-muted-foreground",
  opencode: "bg-success",
  antigravity: "bg-primary",
};

export const HARNESS_CHOICES: readonly InstructionHarness[] = [
  "all",
  ...HARNESSES.map((entry) => entry.id),
];

export function HarnessSwatch(props: { harness: InstructionHarness }) {
  return (
    <span aria-hidden className={cn("size-2 shrink-0 rounded-full", HARNESS_RAIL[props.harness])} />
  );
}

function HarnessSelect(props: {
  harness: InstructionHarness;
  disabled: boolean;
  onChange: (harness: InstructionHarness) => void;
}) {
  return (
    <Select
      value={props.harness}
      disabled={props.disabled}
      onValueChange={(value) => {
        const next = HARNESS_CHOICES.find((harness) => harness === value);
        if (next) props.onChange(next);
      }}
    >
      <SelectTrigger size="xs" variant="ghost" aria-label="Which harness reads this block">
        <SelectValue>
          <span className="flex items-center gap-1.5">
            {props.harness === "all" ? (
              <HarnessSwatch harness="all" />
            ) : (
              <HarnessGlyph harness={props.harness} />
            )}
            {harnessLabel(props.harness)}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="start" alignItemWithTrigger={false}>
        {HARNESS_CHOICES.map((harness) => (
          <SelectItem key={harness} value={harness}>
            <span className="flex items-center gap-2">
              <HarnessSwatch harness={harness} />
              {harnessLabel(harness)}
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

export function InstructionBlockEditor(props: {
  block: InstructionBlock;
  readOnly: boolean;
  onChange: (block: InstructionBlock) => void;
  onRemove: () => void;
}) {
  const { block } = props;
  return (
    <div className="group/block flex min-w-0 gap-3 rounded-md pl-1 hover:bg-accent/24 focus-within:bg-accent/40">
      <span
        aria-hidden
        className={cn("my-2 w-0.5 shrink-0 self-stretch rounded-full", HARNESS_RAIL[block.harness])}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1 py-1.5 pr-1.5">
        <div className="flex items-center gap-2">
          <HarnessSelect
            harness={block.harness}
            disabled={props.readOnly}
            onChange={(harness) => props.onChange({ ...block, harness })}
          />
          {props.readOnly ? null : (
            <Button
              size="icon-xs"
              variant="ghost-destructive"
              aria-label="Remove block"
              className="ms-auto"
              onClick={props.onRemove}
            >
              <Trash2Icon aria-hidden />
            </Button>
          )}
        </div>
        <textarea
          value={block.text}
          readOnly={props.readOnly}
          onChange={(event) => props.onChange({ ...block, text: event.currentTarget.value })}
          placeholder="Markdown for this block"
          aria-label={`${harnessLabel(block.harness)} block`}
          spellCheck={false}
          rows={2}
          className="field-sizing-content w-full resize-none bg-transparent px-2 font-mono text-xs leading-5 text-foreground outline-none placeholder:text-placeholder read-only:text-muted-foreground"
        />
      </div>
    </div>
  );
}
