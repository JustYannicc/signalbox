import type { ComponentProps } from "react";

import { ModelPickerContent as T3ModelPickerContent } from "./ModelPickerContent";
import { ModelPickerEnvironment } from "./SignalboxModelListRow";

export function ModelPickerContent(props: ComponentProps<typeof T3ModelPickerContent>) {
  return (
    <ModelPickerEnvironment value={props.environmentId}>
      <T3ModelPickerContent {...props} />
    </ModelPickerEnvironment>
  );
}
