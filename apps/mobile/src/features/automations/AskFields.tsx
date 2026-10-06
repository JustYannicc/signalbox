import type { AskDraftValue } from "@t3tools/client-runtime/automations/ask";
import { automationOptionLabel, type AutomationAskField } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { Platform, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { PillButton } from "./AutomationParts";

function FieldLabel(props: { readonly field: AutomationAskField }) {
  return (
    <Text className="text-sm font-t3-medium text-foreground-muted">
      {props.field.label}
      {props.field.required ? <Text className="text-danger-foreground"> *</Text> : null}
    </Text>
  );
}

export function AskField(props: {
  readonly field: AutomationAskField;
  readonly value: AskDraftValue;
  readonly disabled: boolean;
  readonly onChange: (value: AskDraftValue) => void;
}) {
  const { field, value } = props;
  const a11yLabel = field.required ? `${field.label}, required` : field.label;

  if (field.type === "boolean") {
    return (
      <View className="min-h-11 flex-row items-center justify-between gap-3">
        <View className="min-w-0 flex-1">
          <FieldLabel field={field} />
        </View>
        <ThemedSwitch
          accessibilityLabel={a11yLabel}
          value={value === true}
          disabled={props.disabled}
          onValueChange={props.onChange}
        />
      </View>
    );
  }

  if (field.type === "choice") {
    return (
      <View className="gap-1.5">
        <FieldLabel field={field} />
        <View accessibilityRole="radiogroup" className="flex-row flex-wrap gap-2">
          {field.options.map((option) => (
            <PillButton
              key={option}
              label={automationOptionLabel(option)}
              accessibilityRole="radio"
              tone={value === option ? "primary" : "secondary"}
              selected={value === option}
              disabled={props.disabled}
              onPress={() => {
                void Haptics.selectionAsync();
                // Tapping the picked option again clears it.
                props.onChange(value === option ? null : option);
              }}
            />
          ))}
        </View>
      </View>
    );
  }

  const text = typeof value === "string" ? value : "";
  return (
    <View className="gap-1.5">
      <FieldLabel field={field} />
      {field.type === "longText" ? (
        <AppTextInput
          accessibilityLabel={a11yLabel}
          value={text}
          onChangeText={props.onChange}
          editable={!props.disabled}
          multiline
          scrollEnabled
          textAlignVertical="top"
          className="max-h-64 min-h-28"
        />
      ) : (
        <AppTextInput
          accessibilityLabel={a11yLabel}
          value={text}
          onChangeText={props.onChange}
          editable={!props.disabled}
          returnKeyType="done"
          keyboardType={
            field.type !== "number"
              ? "default"
              : // iOS's number pads have no minus key.
                Platform.OS === "ios"
                ? "numbers-and-punctuation"
                : "numeric"
          }
        />
      )}
    </View>
  );
}
