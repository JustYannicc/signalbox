import type { SignalboxAskQuestion } from "@t3tools/contracts/signalboxAsks";
import { askKitFontFamily, type AskKitOptionLooks } from "@t3tools/shared/askKit";

import { Button } from "../ui/button";

function toggleOption(
  selected: ReadonlyArray<number>,
  index: number,
  multiSelect: boolean,
): ReadonlyArray<number> {
  if (selected.includes(index)) return selected.filter((item) => item !== index);
  return multiSelect ? [...selected, index].sort((a, b) => a - b) : [index];
}

/** An option's label in the look the agent gave it: its font, and a swatch of its colour. */
export function AskOptionLabel(props: {
  readonly label: string;
  readonly look: AskKitOptionLooks[number] | undefined;
}) {
  const { look } = props;
  return (
    <>
      {look?.color ? (
        <span
          aria-hidden
          className="size-2.5 shrink-0 rounded-full ring-1 ring-foreground/15"
          style={{ backgroundColor: look.color }}
        />
      ) : null}
      <span style={look?.font ? { fontFamily: askKitFontFamily(look.font) } : undefined}>
        {props.label}
      </span>
    </>
  );
}

export function AskChoices(props: {
  readonly label: string;
  readonly options: SignalboxAskQuestion["options"];
  readonly selected: ReadonlyArray<number>;
  readonly multiSelect: boolean;
  readonly looks?: AskKitOptionLooks;
  readonly disabled: boolean;
  readonly onChange: (selected: ReadonlyArray<number>) => void;
}) {
  return (
    <div role="group" aria-label={props.label} className="flex flex-wrap gap-1.5">
      {props.options.map((option, index) => {
        const selected = props.selected.includes(index);
        return (
          <Button
            key={`${option.label}:${JSON.stringify(option.value)}`}
            type="button"
            size="sm"
            variant={selected ? "secondary" : "outline"}
            aria-pressed={selected}
            title={option.description}
            disabled={props.disabled}
            onClick={() => props.onChange(toggleOption(props.selected, index, props.multiSelect))}
          >
            <AskOptionLabel label={option.label} look={props.looks?.[index]} />
          </Button>
        );
      })}
    </div>
  );
}
