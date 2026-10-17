import type { ComponentProps } from "react";
import { createContext, memo, use } from "react";
import type { EnvironmentId } from "@t3tools/contracts";

import { useEnvironmentCanWriteModelSettings } from "~/state/environmentCapabilities";
import { ModelListRow as T3ModelListRow } from "./ModelListRow";

export const ModelPickerEnvironment = createContext<EnvironmentId | null>(null);

export const ModelListRow = memo(function SignalboxModelListRow(
  props: Omit<ComponentProps<typeof T3ModelListRow>, "canToggleFavorite">,
) {
  const environmentId = use(ModelPickerEnvironment);
  const canToggleFavorite = useEnvironmentCanWriteModelSettings(environmentId);
  return <T3ModelListRow {...props} canToggleFavorite={canToggleFavorite} />;
});
