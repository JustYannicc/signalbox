import type { ModelSelection } from "@t3tools/contracts";
import { useMemo } from "react";
import {
  useEffectiveComposerModelState,
  type ComposerThreadDraftState,
  type EffectiveComposerModelState,
} from "../composerDraftStore";

type LegacyModelStateInput = Parameters<typeof useEffectiveComposerModelState>[0];

export function deriveSignalboxComposerModelState(input: {
  legacyState: EffectiveComposerModelState;
  composerDraft: Pick<ComposerThreadDraftState, "modelSelectionExplicit">;
  isNewThreadDraft: boolean;
  initialModelSelection: ModelSelection | null | undefined;
  selectedInstanceId: LegacyModelStateInput["selectedInstanceId"];
}): EffectiveComposerModelState {
  if (!input.isNewThreadDraft || input.composerDraft.modelSelectionExplicit === true) {
    return input.legacyState;
  }

  const selection =
    input.initialModelSelection?.instanceId === input.selectedInstanceId
      ? input.initialModelSelection
      : null;

  return {
    selectedModel: selection?.model ?? "",
    modelOptions:
      selection?.options && selection.options.length > 0
        ? { [selection.instanceId]: selection.options }
        : null,
  };
}

export function useSignalboxEffectiveComposerModelState(
  input: LegacyModelStateInput & {
    composerDraft: ComposerThreadDraftState;
    isNewThreadDraft: boolean;
    initialModelSelection: ModelSelection | null | undefined;
  },
): EffectiveComposerModelState {
  const { composerDraft, isNewThreadDraft, initialModelSelection, ...legacyInput } = input;
  const legacyState = useEffectiveComposerModelState(legacyInput);

  return useMemo(
    () =>
      deriveSignalboxComposerModelState({
        legacyState,
        composerDraft,
        isNewThreadDraft,
        initialModelSelection,
        selectedInstanceId: legacyInput.selectedInstanceId,
      }),
    [
      composerDraft.modelSelectionExplicit,
      initialModelSelection,
      isNewThreadDraft,
      legacyInput.selectedInstanceId,
      legacyState,
    ],
  );
}
