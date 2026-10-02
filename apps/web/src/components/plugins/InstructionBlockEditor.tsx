/**
 * One AGENTS.md block: a colored gutter for who sees it, the visibility
 * picker, and the markdown itself.
 */
import { Trash2Icon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  audienceLabel,
  type InstructionAudience,
  type InstructionBlock,
} from "./instructionsModel";
import { HARNESSES } from "./pluginsModel";
import { HarnessGlyph } from "./pluginsPrimitives";

/** Gutter color per audience. Blocks for everyone stay neutral so harness-only ones stand out. */
export const AUDIENCE_RAIL: Record<InstructionAudience, string> = {
  all: "bg-border",
  claudeAgent: "bg-warning",
  codex: "bg-foreground",
  cursor: "bg-info",
  grok: "bg-muted-foreground",
  opencode: "bg-success",
  antigravity: "bg-primary",
};

const AUDIENCES: readonly InstructionAudience[] = [
  "all",
  ...HARNESSES.map((harness) => harness.id),
];

export function AudienceSwatch(props: { audience: InstructionAudience }) {
  return (
    <span
      aria-hidden
      className={cn("size-2 shrink-0 rounded-full", AUDIENCE_RAIL[props.audience])}
    />
  );
}

function AudienceSelect(props: {
  audience: InstructionAudience;
  disabled: boolean;
  onChange: (audience: InstructionAudience) => void;
}) {
  return (
    <Select
      value={props.audience}
      disabled={props.disabled}
      onValueChange={(value) => {
        const next = AUDIENCES.find((audience) => audience === value);
        if (next) props.onChange(next);
      }}
    >
      <SelectTrigger size="xs" variant="ghost" aria-label="Who sees this block">
        <SelectValue>
          <span className="flex items-center gap-1.5">
            {props.audience === "all" ? (
              <AudienceSwatch audience="all" />
            ) : (
              <HarnessGlyph harness={props.audience} />
            )}
            {audienceLabel(props.audience)}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="start" alignItemWithTrigger={false}>
        {AUDIENCES.map((audience) => (
          <SelectItem key={audience} value={audience}>
            <span className="flex items-center gap-2">
              <AudienceSwatch audience={audience} />
              {audienceLabel(audience)}
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
        className={cn(
          "my-2 w-0.5 shrink-0 self-stretch rounded-full",
          AUDIENCE_RAIL[block.audience],
        )}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1 py-1.5 pr-1.5">
        <div className="flex items-center gap-2">
          <AudienceSelect
            audience={block.audience}
            disabled={props.readOnly}
            onChange={(audience) => props.onChange({ ...block, audience })}
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
          aria-label={`${audienceLabel(block.audience)} block`}
          spellCheck={false}
          rows={2}
          className="field-sizing-content w-full resize-none bg-transparent px-2 font-mono text-xs leading-5 text-foreground outline-none placeholder:text-placeholder read-only:text-muted-foreground"
        />
      </div>
    </div>
  );
}
