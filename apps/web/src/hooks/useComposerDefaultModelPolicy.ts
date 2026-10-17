import { useAtomValue } from "@effect/atom-react";
import { resolveComposerProviderSelection } from "../components/ChatView.logic";
import type { ChatComposerProps } from "../components/chat/ChatComposer";
import type { ComposerThreadDraftState } from "../composerDraftStore";
import type { ProviderInstanceEntry } from "../providerInstances";
import { environmentServerConfigsAtom } from "../state/server";
import {
  mapDefaultModelSelectionToPool,
  resolveComposerDefaultModelSelection,
  resolveFreshComposerModelSelection,
} from "../lib/defaultModelSelectionPolicy";
import { useProjectPoolModelSelection } from "../state/projectPool";

type ComposerProviderSelection = ReturnType<typeof resolveComposerProviderSelection> & {
  readonly providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
};

export function useComposerDefaultModelPolicy(input: {
  readonly props: ChatComposerProps;
  readonly composerDraft: ComposerThreadDraftState;
  readonly providerSelection: ComposerProviderSelection;
}) {
  const { props, composerDraft, providerSelection } = input;
  const mapToPool = useProjectPoolModelSelection();
  const environmentConfigs = useAtomValue(environmentServerConfigsAtom);
  const personDefaultSelection =
    props.environmentId === null
      ? null
      : (environmentConfigs.get(props.environmentId)?.settings.defaultModelSelection ?? null);
  const isNewThreadDraft = props.routeKind === "draft";
  const draftModelSelectionExplicit = composerDraft.modelSelectionExplicit === true;
  const draftSelection = composerDraft.activeProvider
    ? (composerDraft.modelSelectionByProvider[composerDraft.activeProvider] ?? null)
    : null;
  const useFreshDefault = isNewThreadDraft && !draftModelSelectionExplicit;
  const defaults = resolveComposerDefaultModelSelection({
    isNewThreadDraft,
    draftModelSelectionExplicit,
    projectDefaultSelection: props.activeProjectDefaultModelSelection,
    personDefaultSelection,
    settings: props.settings,
    projectId: props.activeProjectId,
    providers: providerSelection.providerInstanceEntries.map((entry) => entry.snapshot),
  });
  const poolSelection =
    useFreshDefault && props.environmentId !== null
      ? mapToPool({
          environmentId: props.environmentId,
          projectId: props.activeProjectId,
          threadId: props.activeThreadId,
          selection: defaults.initialModelSelection,
          providerInstances: props.settings.providerInstances,
          providers: props.providerStatuses,
        })
      : null;
  const initialDefaultSelection = mapDefaultModelSelectionToPool(
    useFreshDefault ? defaults.initialModelSelection : null,
    () => poolSelection,
  );
  const resolvedDraftModelSelection = resolveFreshComposerModelSelection({
    isNewThreadDraft,
    draftModelSelectionExplicit,
    draftSelection,
    initialModelSelection: initialDefaultSelection,
    poolSelection: null,
  });
  const initialModelSelection = useFreshDefault ? resolvedDraftModelSelection : null;
  const selectedProviderSelection = useFreshDefault
    ? resolveComposerProviderSelection({
        entries: providerSelection.providerInstanceEntries,
        candidateInstanceIds: [initialModelSelection?.instanceId],
        lockedProvider: props.lockedProvider,
        lockedInstanceId: null,
      })
    : providerSelection;
  return {
    initialModelSelection,
    selectedProviderSelection,
  };
}
