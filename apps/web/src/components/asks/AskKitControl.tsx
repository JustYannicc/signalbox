import type { ScopedThreadRef } from "@t3tools/contracts";
import type { SignalboxAskQuestion } from "@t3tools/contracts/signalboxAsks";
import type { AskKitComponentSpec } from "@t3tools/shared/askKit";
import type { AskKitValue } from "@t3tools/shared/askKitAnswer";

import { Textarea } from "../ui/textarea";
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
  readonly threadRef: ScopedThreadRef;
  /** Labels the text component's field, which stands in for the comment. */
  readonly inputId: string;
  readonly onChange: (value: AskKitValue | undefined) => void;
}) {
  const { question, spec, value, disabled, onChange } = props;
  const label = `Answer: ${question.question}`;
  switch (spec.component) {
    case "choices":
      return (
        <AskChoices
          label={label}
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
          label={label}
          options={question.options}
          spec={spec}
          selected={value?.component === "compare" ? value.selected : undefined}
          disabled={disabled}
          threadRef={props.threadRef}
          onChange={(selected) =>
            onChange(selected === undefined ? undefined : { component: "compare", selected })
          }
        />
      );
    case "slider":
      return (
        <AskSlider
          label={label}
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
          label={label}
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
        <div className="flex flex-col gap-1">
          <Textarea
            id={props.inputId}
            size="sm"
            placeholder={spec.placeholder ?? "Your answer"}
            maxLength={spec.maxLength}
            value={text}
            disabled={disabled}
            onChange={(event) => {
              const next = event.currentTarget.value;
              onChange(next === "" ? undefined : { component: "text", text: next });
            }}
          />
          {text.length > spec.maxLength * 0.8 ? (
            <span className="self-end text-xs text-muted-foreground tabular-nums">
              {text.length}/{spec.maxLength}
            </span>
          ) : null}
        </div>
      );
    }
  }
}
