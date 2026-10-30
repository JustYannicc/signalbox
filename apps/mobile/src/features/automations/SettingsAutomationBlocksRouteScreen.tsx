import {
  BLOCK_LIBRARY_DISCONNECTED,
  BLOCK_LIBRARY_INTRO,
  BLOCK_LIBRARY_NO_TARGET,
  BLOCK_LIBRARY_STALE_TARGET,
  blockLibraryTargets,
} from "@t3tools/client-runtime/automations/blockLibrary";
import type { EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useMemo, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironmentQuery } from "../../state/query";
import { signalboxContexts } from "../../state/signalboxContexts";
import {
  folderEnvironmentsAtom,
  signalboxFolders,
  useFolderEnvironments,
} from "../../state/signalboxFolders";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsChoiceRow } from "../settings/components/SettingsChoiceRow";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { BlockLibraryBlocks } from "./BlockLibraryBlocks";

/**
 * Settings → Block library (#1056), the web's Settings → Block library: the
 * blocks a folder's automations can start by name, read-only. It looks from a
 * folder of your tree, not from the Settings environment filter.
 */
export function SettingsAutomationBlocksRouteScreen() {
  const insets = useSafeAreaInsets();
  const folderEnvironments = useFolderEnvironments();
  const arrived = useAtomValue(folderEnvironmentsAtom);
  const targets = useMemo(
    () =>
      [...arrived].flatMap(([environmentId, entry]) =>
        blockLibraryTargets(environmentId, entry.owners, entry.snapshot),
      ),
    [arrived],
  );
  const pending = folderEnvironments.filter(
    (environment) => !arrived.has(environment.environmentId),
  );
  const [chosenKey, setChosenKey] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const target =
    targets.find((candidate) => candidate.key === chosenKey) ??
    (chosenKey === null ? (targets[0] ?? null) : null);

  return (
    <SettingsScreen title="Block library">
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {folderEnvironments.length === 0 ? (
          <Text className="px-2 text-foreground-muted">{BLOCK_LIBRARY_DISCONNECTED}</Text>
        ) : (
          <>
            <Text textRole="footnote" className="px-2 text-foreground-muted">
              {BLOCK_LIBRARY_INTRO}
            </Text>
            {pending.map((environment) => (
              <FoldersStatus
                key={environment.environmentId}
                environmentId={environment.environmentId}
              />
            ))}
            {targets.length === 0 ? (
              pending.length > 0 ? null : (
                <Text className="px-2 text-foreground-muted">{BLOCK_LIBRARY_NO_TARGET}</Text>
              )
            ) : (
              <SettingsSection
                title="Folder"
                footer={target === null ? BLOCK_LIBRARY_STALE_TARGET : undefined}
              >
                <SettingsActionRow
                  label={target?.label ?? "Choose a folder"}
                  description={choosing ? undefined : "Change folder"}
                  onPress={() => setChoosing((open) => !open)}
                />
                {choosing
                  ? targets.map((candidate) => (
                      <SettingsChoiceRow
                        key={candidate.key}
                        label={candidate.label}
                        selected={candidate.key === target?.key}
                        separated
                        onPress={() => {
                          setChosenKey(candidate.key);
                          setChoosing(false);
                        }}
                      />
                    ))
                  : null}
              </SettingsSection>
            )}
            {target === null ? null : <BlockLibraryBlocks key={target.key} target={target} />}
          </>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

/** An environment whose folders or their owners haven't arrived: loading, or failed with a retry. */
function FoldersStatus({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const input = { environmentId, input: {} };
  const folders = useEnvironmentQuery(signalboxFolders.snapshot(input));
  const owners = useEnvironmentQuery(signalboxContexts.snapshot(input));
  const error = folders.error ?? owners.error;
  if (error === null) {
    return <Text className="px-2 text-foreground-muted">Loading your folders…</Text>;
  }
  return (
    <SettingsSection title="Could not load your folders" footer={error}>
      <SettingsActionRow
        label="Try again"
        onPress={() => {
          if (folders.error !== null) folders.refresh();
          if (owners.error !== null) owners.refresh();
        }}
      />
    </SettingsSection>
  );
}
