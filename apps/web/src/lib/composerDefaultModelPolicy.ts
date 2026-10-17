import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";

import type { ProviderInstanceEntry } from "../providerInstances";
import { resolveComposerProviderSelection } from "./composerProviderSelection";
import {
  mapDefaultModelSelectionToPool,
  resolveComposerDefaultModelSelection,
  resolveFreshComposerModelSelection,
} from "./defaultModelSelectionPolicy";

type PoolModelSelectionMapper = (input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly threadId?: ThreadId | null;
  readonly selection: ModelSelection | null;
  readonly providerInstances: Readonly<Record<string, { readonly config?: unknown }>>;
  readonly providers: ReadonlyArray<ServerProvider>;
}) => ModelSelection | null;

export type ComposerProviderSelection = ReturnType<typeof resolveComposerProviderSelection> & {
  readonly providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly mapModelSelectionToPool: PoolModelSelectionMapper;
};

export function resolveComposerDefaultModelPolicy(input: {
  readonly environmentId: EnvironmentId;
  readonly routeKind: "server" | "draft";
  readonly activeProjectDefaultModelSelection: ModelSelection | null | undefined;
  readonly activeProjectId: ProjectId | null;
  readonly activeThreadId: ThreadId | null;
  readonly personDefaultModelSelection: ModelSelection | null;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
  readonly lockedProvider: ProviderDriverKind | null;
  readonly composerDraft: {
    readonly activeProvider: ProviderInstanceId | null;
    readonly modelSelectionByProvider: Readonly<
      Partial<Record<ProviderInstanceId, ModelSelection>>
    >;
    readonly modelSelectionExplicit?: boolean;
  };
  readonly providerSelection: ComposerProviderSelection;
}) {
  const {
    environmentId,
    routeKind,
    activeProjectDefaultModelSelection,
    activeProjectId,
    activeThreadId,
    personDefaultModelSelection,
    providerStatuses,
    settings,
    lockedProvider,
    composerDraft,
    providerSelection,
  } = input;
  const isNewThreadDraft = routeKind === "draft";
  const draftModelSelectionExplicit = composerDraft.modelSelectionExplicit === true;
  const draftSelection = composerDraft.activeProvider
    ? (composerDraft.modelSelectionByProvider[composerDraft.activeProvider] ?? null)
    : null;
  const useFreshDefault = isNewThreadDraft && !draftModelSelectionExplicit;
  const defaults = resolveComposerDefaultModelSelection({
    isNewThreadDraft,
    draftModelSelectionExplicit,
    projectDefaultSelection: activeProjectDefaultModelSelection,
    personDefaultSelection: personDefaultModelSelection,
    settings,
    projectId: activeProjectId,
    providers: providerSelection.providerInstanceEntries.map((entry) => entry.snapshot),
  });
  const poolSelection = useFreshDefault
    ? providerSelection.mapModelSelectionToPool({
        environmentId,
        projectId: activeProjectId,
        threadId: activeThreadId,
        selection: defaults.initialModelSelection,
        providerInstances: settings.providerInstances,
        providers: providerStatuses,
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
        lockedProvider,
        lockedInstanceId: null,
      })
    : providerSelection;
  return {
    initialModelSelection,
    selectedProviderSelection,
  };
}
