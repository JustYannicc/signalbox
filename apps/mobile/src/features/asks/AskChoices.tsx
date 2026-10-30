import type { AskKitFont } from "@t3tools/contracts/askKit";
import type { SignalboxAskQuestion } from "@t3tools/contracts/signalboxAsks";
import type { AskKitOptionLooks } from "@t3tools/shared/askKit";
import { Platform, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";

// CSS generic families have no React Native name; map the ones a platform can show.
const GENERIC_FONTS: Partial<Record<string, string | null>> = {
  serif: Platform.select({ ios: "Georgia", default: "serif" }),
  "ui-serif": Platform.select({ ios: "Georgia", default: "serif" }),
  monospace: Platform.select({ ios: "Menlo", default: "monospace" }),
  "ui-monospace": Platform.select({ ios: "Menlo", default: "monospace" }),
  "sans-serif": null,
  "system-ui": null,
  "ui-sans-serif": null,
  "ui-rounded": null,
  cursive: null,
  fantasy: null,
};

/** A device font by name; a name the device lacks falls back to the system font. */
export function nativeFontStyle(font: AskKitFont | undefined) {
  if (font === undefined) return undefined;
  // Own keys only: a font named "constructor" must not find Object.prototype's.
  const family = Object.hasOwn(GENERIC_FONTS, font) ? GENERIC_FONTS[font] : font;
  return family ? { fontFamily: family } : undefined;
}

export function toggleOption(
  selected: ReadonlyArray<number>,
  index: number,
  multiSelect: boolean,
): ReadonlyArray<number> {
  if (selected.includes(index)) return selected.filter((item) => item !== index);
  return multiSelect ? [...selected, index].sort((a, b) => a - b) : [index];
}

export function OptionSwatch(props: { readonly color: string | undefined }) {
  return props.color ? (
    <View
      className="size-3 rounded-full border border-border"
      style={{ backgroundColor: props.color }}
    />
  ) : null;
}

export function AskChoices(props: {
  readonly options: SignalboxAskQuestion["options"];
  readonly selected: ReadonlyArray<number>;
  readonly multiSelect: boolean;
  readonly looks?: AskKitOptionLooks;
  readonly disabled: boolean;
  readonly onChange: (selected: ReadonlyArray<number>) => void;
}) {
  return (
    <View className="flex-row flex-wrap gap-2">
      {props.options.map((option, index) => {
        const selected = props.selected.includes(index);
        const look = props.looks?.[index];
        return (
          <Pressable
            key={`${option.label}:${JSON.stringify(option.value)}`}
            accessibilityRole="button"
            accessibilityLabel={option.label}
            accessibilityHint={option.description}
            accessibilityState={{ selected, disabled: props.disabled }}
            disabled={props.disabled}
            onPress={() => props.onChange(toggleOption(props.selected, index, props.multiSelect))}
            className={cn(
              "flex-row items-center gap-2 rounded-[14px] px-3.5 py-3 active:opacity-70 disabled:opacity-50",
              selected ? "bg-primary" : "bg-subtle-strong",
            )}
          >
            <OptionSwatch color={look?.color} />
            <Text
              className={cn(
                "text-sm",
                selected
                  ? "font-t3-extrabold text-primary-foreground"
                  : "font-t3-bold text-foreground",
              )}
              style={nativeFontStyle(look?.font)}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
