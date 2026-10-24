import type { EnvironmentId } from "@t3tools/contracts";
import type { SignalboxAskQuestion } from "@t3tools/contracts/signalboxAsks";
import type { AskKitComponentSpec } from "@t3tools/shared/askKit";
import type { AskKitValue } from "@t3tools/shared/askKitAnswer";
import { View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { AskChoices } from "./AskChoices";
import { AskCompare } from "./AskCompare";
import { AskRanking } from "./AskRanking";
import { AskSlider } from "./AskSlider";

/** One kit component. `undefined` is untouched: the question is deferred, not answered. */
export function AskKitControl(props: {
  readonly question: SignalboxAskQuestion;
  readonly spec: AskKitComponentSpec;
  readonly value: AskKitValue | undefined;
  readonly disabled: boolean;
  readonly environmentId: EnvironmentId;
  readonly onInputFocusChange: (focused: boolean) => void;
  readonly onChange: (value: AskKitValue | undefined) => void;
}) {
  const { question, spec, value, disabled, onChange } = props;
  switch (spec.component) {
    case "choices":
      return (
        <AskChoices
          options={question.options}
          selected={value?.component === "choices" ? value.selected : []}
          multiSelect={spec.multiSelect}
          looks={spec.looks}
          disabled={disabled}
          onChange={(selected) =>
            onChange(selected.length > 0 ? { component: "choices", selected } : undefined)
          }
        />
      );
    case "compare":
      return (
        <AskCompare
          options={question.options}
          spec={spec}
          selected={value?.component === "compare" ? value.selected : undefined}
          disabled={disabled}
          environmentId={props.environmentId}
          onChange={(selected) =>
            onChange(selected === undefined ? undefined : { component: "compare", selected })
          }
        />
      );
    case "slider":
      return (
        <AskSlider
          label={`Answer: ${question.question}`}
          spec={spec}
          value={value?.component === "slider" ? value.value : undefined}
          disabled={disabled}
          onChange={(next) =>
            onChange(next === undefined ? undefined : { component: "slider", value: next })
          }
        />
      );
    case "ranking":
      return (
        <AskRanking
          options={question.options}
          looks={spec.looks}
          order={value?.component === "ranking" ? value.order : undefined}
          disabled={disabled}
          onChange={(order) =>
            onChange(order === undefined ? undefined : { component: "ranking", order })
          }
        />
      );
    case "text": {
      const text = value?.component === "text" ? value.text : "";
      return (
        <View className="gap-1">
          <TextInput
            accessibilityLabel={`Answer: ${question.question}`}
            placeholder={spec.placeholder ?? "Your answer"}
            multiline
            maxLength={spec.maxLength}
            value={text}
            editable={!disabled}
            onChangeText={(next) =>
              onChange(next === "" ? undefined : { component: "text", text: next })
            }
            onFocus={() => props.onInputFocusChange(true)}
            onBlur={() => props.onInputFocusChange(false)}
          />
          {text.length > spec.maxLength * 0.8 ? (
            <Text className="self-end font-sans text-xs text-foreground-muted">
              {text.length}/{spec.maxLength}
            </Text>
          ) : null}
        </View>
      );
    }
  }
}
