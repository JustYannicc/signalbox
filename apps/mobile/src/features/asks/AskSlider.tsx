import {
  formatSliderValue,
  sliderPositionOf,
  sliderStepCount,
  sliderValueAt,
} from "@t3tools/client-runtime/askSlider";
import type { AskKitComponentSpec } from "@t3tools/shared/askKit";
import { useLayoutEffect, useRef, useState } from "react";
import { PanResponder, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { RequestActionButton } from "../threads/RequestActionButton";

type SliderSpec = Extract<AskKitComponentSpec, { component: "slider" }>;

const TRACK_HEIGHT = 40;
const THUMB = 24;
// Points a finger must move sideways, more than it moves up or down, before the slider takes it.
const HORIZONTAL_SLOP = 4;

/**
 * Untouched, the thumb rests dimmed at the start and nothing is sent. A touch, a drag or the
 * step buttons set a value; screen readers adjust it with the usual swipe. Clear unsets it.
 */
export function AskSlider(props: {
  readonly label: string;
  readonly spec: SliderSpec;
  readonly value: number | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: number | undefined) => void;
}) {
  const { spec, value, disabled } = props;
  const [width, setWidth] = useState(0);
  const steps = sliderStepCount(spec);
  const position = value === undefined ? 0 : sliderPositionOf(spec, value);
  const ratio = steps === 0 ? 0 : position / steps;
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });

  // The responder lives for the component's life; its handlers read the latest values through
  // refs. Only a deliberate horizontal drag answers: a touch, a tap or a vertical scroll that
  // crosses the track never claims it. Each move is the touch origin plus the drag.
  const trackWidth = useRef(0);
  // oxlint-disable-next-line react/refs -- Builds handlers only; they read refs when a touch arrives.
  const [responder] = useState(() => {
    const start = { x: 0 };
    const setAt = (x: number) => {
      const current = latest.current;
      if (current.disabled || trackWidth.current <= 0) return;
      const count = sliderStepCount(current.spec);
      current.onChange(sliderValueAt(current.spec, (x / trackWidth.current) * count));
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_event, gesture) =>
        !latest.current.disabled &&
        Math.abs(gesture.dx) > Math.abs(gesture.dy) &&
        Math.abs(gesture.dx) > HORIZONTAL_SLOP,
      // Keep the drag once it's ours, even if the surrounding list would like to scroll.
      onPanResponderTerminationRequest: () => false,
      // By the time a drag is claimed the finger has moved; the origin is where it started.
      onPanResponderGrant: (event, gesture) => {
        start.x = event.nativeEvent.locationX - gesture.dx;
      },
      onPanResponderMove: (_event, gesture) => setAt(start.x + gesture.dx),
    });
  });
  // From unset, + takes the first step and − settles on the start.
  const nudge = (by: number) => {
    if (disabled) return;
    const next = value === undefined ? Math.max(0, by) : position + by;
    props.onChange(sliderValueAt(spec, next));
  };

  return (
    <View className="gap-2">
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={props.label}
        accessibilityState={{ disabled }}
        // React Native's range is integers, so it counts positions; the text says the value.
        accessibilityValue={
          value === undefined
            ? { text: "Not set" }
            : { min: 0, max: steps, now: position, text: formatSliderValue(spec, value) }
        }
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(event) =>
          nudge(event.nativeEvent.actionName === "increment" ? 1 : -1)
        }
        onLayout={(event) => {
          trackWidth.current = event.nativeEvent.layout.width;
          setWidth(event.nativeEvent.layout.width);
        }}
        className={cn("justify-center", disabled && "opacity-50")}
        style={{ height: TRACK_HEIGHT }}
        {...responder.panHandlers}
      >
        <View className="h-1.5 rounded-full bg-subtle-strong">
          {value === undefined ? null : (
            <View className="h-1.5 rounded-full bg-primary" style={{ width: ratio * width }} />
          )}
        </View>
        <View
          pointerEvents="none"
          className={cn(
            "absolute rounded-full border border-border bg-card",
            value === undefined && "opacity-60",
          )}
          style={{
            width: THUMB,
            height: THUMB,
            top: (TRACK_HEIGHT - THUMB) / 2,
            left: Math.max(0, Math.min(width - THUMB, ratio * width - THUMB / 2)),
          }}
        />
      </View>
      <View className="flex-row justify-between gap-3">
        <Text className="font-sans text-xs text-foreground-muted">
          {spec.startLabel ?? formatSliderValue(spec, spec.min)}
        </Text>
        <Text className="font-sans text-xs text-foreground-muted">
          {spec.endLabel ?? formatSliderValue(spec, spec.max)}
        </Text>
      </View>
      <View className="flex-row items-center gap-2">
        <Text className="flex-1 font-t3-bold text-sm text-foreground">
          {value === undefined ? "Not set" : formatSliderValue(spec, value)}
        </Text>
        <RequestActionButton
          label="−"
          tone="secondary"
          accessibilityLabel="Step down"
          disabled={disabled || (value !== undefined && position <= 0)}
          onPress={() => nudge(-1)}
        />
        <RequestActionButton
          label="+"
          tone="secondary"
          accessibilityLabel="Step up"
          disabled={disabled || position >= steps}
          onPress={() => nudge(1)}
        />
        {value === undefined ? null : (
          <RequestActionButton
            label="Clear"
            tone="secondary"
            disabled={disabled}
            onPress={() => props.onChange(undefined)}
          />
        )}
      </View>
    </View>
  );
}
