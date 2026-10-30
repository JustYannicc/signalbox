import { Slider } from "@base-ui/react/slider";
import {
  formatSliderValue,
  sliderPositionOf,
  sliderStepCount,
  sliderValueAt,
} from "@t3tools/client-runtime/askSlider";
import type { AskKitComponentSpec } from "@t3tools/shared/askKit";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

type SliderSpec = Extract<AskKitComponentSpec, { component: "slider" }>;

/**
 * Untouched, the thumb rests dimmed at the start and nothing is sent. Any drag, click or key
 * sets a value, including settling on the start itself; Clear returns to untouched. Base UI
 * moves through grid positions, and the shared helper turns each into the value both clients send.
 */
export function AskSlider(props: {
  readonly label: string;
  readonly spec: SliderSpec;
  readonly value: number | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: number | undefined) => void;
}) {
  const { spec, value } = props;
  const set = value !== undefined;
  const choose = (position: number) => props.onChange(sliderValueAt(spec, position));
  return (
    <div className="flex flex-col gap-1.5">
      <Slider.Root
        value={set ? sliderPositionOf(spec, value) : 0}
        min={0}
        max={sliderStepCount(spec)}
        step={1}
        disabled={props.disabled}
        onValueChange={choose}
        onValueCommitted={choose}
      >
        <Slider.Control className="flex h-6 w-full touch-none items-center select-none">
          <Slider.Track className="relative h-1 w-full rounded-full bg-muted">
            {set ? <Slider.Indicator className="h-full rounded-full bg-primary" /> : null}
            <Slider.Thumb
              aria-label={props.label}
              getAriaValueText={(_, position) =>
                set ? formatSliderValue(spec, sliderValueAt(spec, position)) : "Not set"
              }
              className={cn(
                "size-4 rounded-full border border-border bg-background shadow-sm/10 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                !set && "opacity-60",
              )}
            />
          </Slider.Track>
        </Slider.Control>
      </Slider.Root>
      <div className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
        <span>{spec.startLabel ?? formatSliderValue(spec, spec.min)}</span>
        <span className="text-end">{spec.endLabel ?? formatSliderValue(spec, spec.max)}</span>
      </div>
      <div className="flex min-h-6 items-center gap-2 text-sm">
        {set ? (
          <>
            <span className="font-medium tabular-nums">{formatSliderValue(spec, value)}</span>
            <Button
              type="button"
              size="xs"
              variant="ghost-muted"
              disabled={props.disabled}
              onClick={() => props.onChange(undefined)}
            >
              Clear
            </Button>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">
            Not set. Drag or use the arrow keys.
          </span>
        )}
      </div>
    </div>
  );
}
