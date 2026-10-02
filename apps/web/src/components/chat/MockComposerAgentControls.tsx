/**
 * The real composer's harness controls for a MockBoundComposer: provider/model
 * picker, reasoning traits and, for `variant="full"`, the mode/access menu. The
 * "model" variant stops at the model and traits, for agents whose mode and access
 * aren't the user's to steer (the assistant and supervisors). The selection lives in the
 * composer draft store under a synthetic draft id per surface, the same way a
 * draft thread keeps it, and starts from the user's default model in settings.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import { createModelSelection, normalizeModelSlug } from "@t3tools/shared/model";
import { useMemo, useState } from "react";

import {
  DraftId,
  useComposerDraftStore,
  useEffectiveComposerModelState,
} from "../../composerDraftStore";
import { usePrimarySettings } from "../../hooks/useSettings";
import { type AppModelOption, getAppModelOptionsForInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  NO_PROVIDER_MODEL_SELECTION,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { primaryServerKeybindingsAtom, primaryServerProvidersAtom } from "../../state/server";
import {
  resolveComposerInteractionMode,
  resolveComposerProviderSelection,
} from "../ChatView.logic";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { ComposerControlSeparator } from "./ComposerControl";
import { renderProviderTraitsPicker } from "./composerProviderState";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { ALWAYS_FULL_ACCESS, effectiveRuntimeMode } from "../../lib/fullAccessPolicy";

export function MockComposerAgentControls(props: {
  targetKey: string;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  /** "full" (default) adds plan mode and runtime access. */
  variant?: "model" | "full";
}) {
  const providers = useAtomValue(primaryServerProvidersAtom);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const settings = usePrimarySettings();
  const draftId = useMemo(
    () => DraftId.make(`mock-composer:${props.targetKey}`),
    [props.targetKey],
  );
  const draftActiveProvider = useComposerDraftStore(
    (store) => store.draftsByThreadKey[draftId]?.activeProvider ?? null,
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(() =>
    effectiveRuntimeMode(settings.defaultRuntimeMode),
  );
  const [requestedInteractionMode, setInteractionMode] =
    useState<ProviderInteractionMode>("default");

  const entries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const { selectedProviderEntry, requestedDriverKind } = resolveComposerProviderSelection({
    entries,
    candidateInstanceIds: [draftActiveProvider, settings.defaultModelSelection?.instanceId],
    lockedProvider: null,
    lockedInstanceId: null,
  });
  const selectedInstanceId: ProviderInstanceId =
    selectedProviderEntry?.instanceId ?? NO_PROVIDER_MODEL_SELECTION.instanceId;
  const selectedProvider = selectedProviderEntry?.driverKind ?? requestedDriverKind;
  const { modelOptions, selectedModel } = useEffectiveComposerModelState({
    draftId,
    providers,
    selectedProvider,
    selectedInstanceId,
    threadModelSelection: null,
    projectModelSelection: settings.defaultModelSelection,
    settings,
  });
  const modelOptionsByInstance = new Map<ProviderInstanceId, ReadonlyArray<AppModelOption>>();
  for (const entry of entries) {
    modelOptionsByInstance.set(
      entry.instanceId,
      getAppModelOptionsForInstance(
        settings,
        entry,
        entry.instanceId === selectedInstanceId ? selectedModel : null,
      ),
    );
  }
  const pickerModel = (modelOptionsByInstance.get(selectedInstanceId) ?? []).some(
    (option) => option.slug === selectedModel,
  )
    ? selectedModel
    : (normalizeModelSlug(selectedModel, selectedProvider) ?? selectedModel);
  const { enabled: planModeUiEnabled, interactionMode } = resolveComposerInteractionMode({
    planModeEnabled: settings.planModeEnabled,
    provider: selectedProviderEntry?.snapshot ?? null,
    interactionMode: requestedInteractionMode,
  });
  const traitsInput = {
    provider: selectedProvider,
    instanceId: selectedInstanceId,
    draftId,
    model: selectedModel,
    models: selectedProviderEntry?.models ?? [],
    modelOptions: modelOptions?.[selectedInstanceId],
    prompt: props.prompt,
    onPromptChange: props.onPromptChange,
    // Traits can carry a provider's own plan agent; the model variant hides it too.
    planModeEnabled: props.variant !== "model" && settings.planModeEnabled,
    isComposerOwned: true,
  } satisfies Parameters<typeof renderProviderTraitsPicker>[0];
  const traitsPicker = renderProviderTraitsPicker(traitsInput);

  return (
    <>
      <ProviderModelPicker
        isComposerOwned
        activeInstanceId={selectedInstanceId}
        model={pickerModel}
        lockedProvider={null}
        instanceEntries={entries}
        keybindings={keybindings}
        modelOptionsByInstance={modelOptionsByInstance}
        size="sm"
        triggerClassName="-ms-2.5 min-w-13"
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        instanceIndicatorBackground="var(--contrast-input)"
        onInstanceModelChange={(instanceId, model) =>
          useComposerDraftStore
            .getState()
            .setModelSelection(draftId, createModelSelection(instanceId, model), { explicit: true })
        }
      />
      {traitsPicker ? (
        <>
          <ComposerControlSeparator size="sm" />
          {traitsPicker}
        </>
      ) : null}
      {props.variant === "model" || (ALWAYS_FULL_ACCESS && !planModeUiEnabled) ? null : (
        <CompactComposerControlsMenu
          interactionMode={interactionMode}
          runtimeMode={runtimeMode}
          showInteractionModeToggle={planModeUiEnabled}
          onToggleInteractionMode={() =>
            setInteractionMode((mode) => (mode === "plan" ? "default" : "plan"))
          }
          onRuntimeModeChange={setRuntimeMode}
        />
      )}
    </>
  );
}
