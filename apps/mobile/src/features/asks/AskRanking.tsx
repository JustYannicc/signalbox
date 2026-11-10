import type { SignalboxAskQuestion } from "@t3tools/contracts/signalboxAsks";
import type { AskKitOptionLooks } from "@t3tools/shared/askKit";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { RequestActionButton } from "../threads/RequestActionButton";
import { nativeFontStyle, OptionSwatch } from "./AskChoices";

function MoveButton(props: {
  readonly label: string;
  readonly direction: "up" | "down";
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      hitSlop={6}
      className="size-9 items-center justify-center rounded-full active:opacity-70 disabled:opacity-30"
    >
      <SymbolView
        name={props.direction === "up" ? "arrow.up" : "arrow.down"}
        size={16}
        weight="semibold"
        tintColorClassName="accent-icon"
        type="monochrome"
      />
    </Pressable>
  );
}

/**
 * Shown in the options' own order until the person ranks them. A move ranks them; so does
 * "Keep this order" when the shown order is already the answer. Reset returns to unranked.
 */
export function AskRanking(props: {
  readonly options: SignalboxAskQuestion["options"];
  readonly looks: AskKitOptionLooks;
  readonly order: ReadonlyArray<number> | undefined;
  readonly disabled: boolean;
  readonly onChange: (order: ReadonlyArray<number> | undefined) => void;
}) {
  const order = props.order ?? props.options.map((_, index) => index);
  const move = (from: number, to: number) => {
    const next = [...order];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    props.onChange(next);
  };
  return (
    <View className="gap-2">
      {order.map((option, position) => {
        const label = props.options[option]?.label ?? "";
        const look = props.looks[option];
        return (
          <View
            key={option}
            accessibilityLabel={`${position + 1}. ${label}`}
            className="flex-row items-center gap-2 rounded-[14px] border border-border bg-card px-3 py-1"
          >
            <Text className="w-5 font-sans text-xs text-foreground-muted">{position + 1}</Text>
            <OptionSwatch color={look?.color} />
            <Text
              className="flex-1 font-t3-bold text-sm text-foreground"
              style={nativeFontStyle(look?.font)}
            >
              {label}
            </Text>
            <MoveButton
              label={`Move ${label} up`}
              direction="up"
              disabled={props.disabled || position === 0}
              onPress={() => move(position, position - 1)}
            />
            <MoveButton
              label={`Move ${label} down`}
              direction="down"
              disabled={props.disabled || position === order.length - 1}
              onPress={() => move(position, position + 1)}
            />
          </View>
        );
      })}
      {props.order === undefined ? (
        <View className="flex-row items-center gap-2">
          <Text className="flex-1 font-sans text-sm text-foreground-muted">Not ranked yet.</Text>
          <RequestActionButton
            label="Keep this order"
            tone="secondary"
            disabled={props.disabled}
            onPress={() => props.onChange(order)}
          />
        </View>
      ) : (
        <RequestActionButton
          label="Reset ranking"
          tone="secondary"
          disabled={props.disabled}
          onPress={() => props.onChange(undefined)}
        />
      )}
    </View>
  );
}
