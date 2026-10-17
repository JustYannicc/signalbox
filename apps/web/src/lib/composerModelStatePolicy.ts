import type {
  ModelSelection,
  ProviderInstanceId,
  ProviderOptionSelection,
} from "@t3tools/contracts";
import { useMemo } from "react";

export interface EffectiveComposerModelState {
  readonly selectedModel: string;
  readonly modelOptions: Partial<Record<string, ReadonlyArray<ProviderOptionSelection>>> | null;
}

export function deriveSignalboxComposerModelState(input: {
  legacyState: EffectiveComposerModelState;
  composerDraft: { readonly modelSelectionExplicit?: boolean };
  isNewThreadDraft: boolean;
  initialModelSelection: ModelSelection | null | undefined;
  selectedInstanceId: ProviderInstanceId | null | undefined;
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

export function useSignalboxEffectiveComposerModelState(input: {
  legacyState: EffectiveComposerModelState;
  composerDraft: { readonly modelSelectionExplicit?: boolean };
  isNewThreadDraft: boolean;
  initialModelSelection: ModelSelection | null | undefined;
  selectedInstanceId: ProviderInstanceId | null | undefined;
}): EffectiveComposerModelState {
  const {
    legacyState,
    composerDraft,
    isNewThreadDraft,
    initialModelSelection,
    selectedInstanceId,
  } = input;

  const modelSelectionExplicit = composerDraft.modelSelectionExplicit;

  return useMemo(
    () =>
      deriveSignalboxComposerModelState({
        legacyState,
        composerDraft: { modelSelectionExplicit },
        isNewThreadDraft,
        initialModelSelection,
        selectedInstanceId,
      }),
    [
      modelSelectionExplicit,
      initialModelSelection,
      isNewThreadDraft,
      legacyState,
      selectedInstanceId,
    ],
  );
}
