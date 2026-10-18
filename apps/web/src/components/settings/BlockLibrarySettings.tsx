/**
 * Settings → Block library (#1056): the blocks a folder's automations can
 * start by name, read-only. It looks from a folder of the person's tree, not
 * from the Settings scope, because blocks resolve along folders.
 *
 * @module BlockLibrarySettings
 */
import { useAtomValue } from "@effect/atom-react";
import {
  BLOCK_LIBRARY_DISCONNECTED,
  BLOCK_LIBRARY_INTRO,
  BLOCK_LIBRARY_NO_TARGET,
  BLOCK_LIBRARY_STALE_TARGET,
  blockLibraryTargets,
  type BlockLibraryTarget,
} from "@t3tools/client-runtime/automations/blockLibrary";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { useEnvironmentQuery } from "~/state/query";
import { signalboxContexts } from "~/state/signalboxContexts";
import { environmentFoldersAtom, signalboxFolders } from "~/state/signalboxFolders";
import { useEnvironments } from "~/state/environments";
import { folderTreesAtom } from "../sidebar/folders/folderThreads";
import { Button } from "../ui/button";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Spinner } from "../ui/spinner";
import { BlockLibraryList } from "./BlockLibraryList";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export function BlockLibrarySettings({ level }: { readonly level?: string | undefined }) {
  const folders = useAtomValue(environmentFoldersAtom);
  const trees = useAtomValue(folderTreesAtom);
  const { environments } = useEnvironments();
  const navigate = useNavigate();

  const targets = [...trees.values()].flatMap((tree) =>
    blockLibraryTargets(tree.environmentId, tree.contexts, tree.snapshot),
  );
  const pending = [...folders.keys()].filter((environmentId) => !trees.has(environmentId));
  const target =
    level === undefined
      ? (targets[0] ?? null)
      : (targets.find((candidate) => candidate.key === level) ?? null);
  const environmentLabels = new Map(
    environments.map((environment) => [environment.environmentId, environment.label]),
  );
  const ownerGroups = groupByOwner(targets, folders.size > 1 ? environmentLabels : null);
  const choose = (key: string | null) => {
    if (key === null) return;
    void navigate({
      to: "/settings/blocks",
      search: (previous) => ({ ...previous, level: key }),
      replace: true,
      hash: "",
    });
  };

  if (folders.size === 0) {
    return (
      <SettingsPageContainer>
        <SettingsSection id="block-library" title="Block library">
          <SettingsRow title="Block library" description={BLOCK_LIBRARY_DISCONNECTED} />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsSection id="block-library" title="Block library">
        <SettingsRow
          title="Folder"
          description={BLOCK_LIBRARY_INTRO}
          control={
            targets.length > 0 ? (
              <Select value={target?.key ?? null} onValueChange={choose}>
                <SelectTrigger size="sm" aria-label="Folder">
                  <SelectValue>{() => target?.label ?? "Choose a folder"}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {ownerGroups.map((group) => (
                    <SelectGroup key={group.key}>
                      <SelectGroupLabel>{group.label}</SelectGroupLabel>
                      {group.targets.map((candidate) => (
                        <SelectItem key={candidate.key} value={candidate.key}>
                          {candidate.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectPopup>
              </Select>
            ) : undefined
          }
        />
        {pending.map((environmentId) => (
          <FoldersStatus
            key={environmentId}
            environmentId={environmentId}
            label={folders.size > 1 ? environmentLabels.get(environmentId) : undefined}
          />
        ))}
        {pending.length === 0 && targets.length === 0 ? (
          <SettingsRow title="No folder to look from" description={BLOCK_LIBRARY_NO_TARGET} />
        ) : null}
        {targets.length > 0 && target === null ? (
          <SettingsRow
            title="That folder isn't available"
            description={BLOCK_LIBRARY_STALE_TARGET}
          />
        ) : null}
      </SettingsSection>
      {target === null ? null : <BlockLibraryList key={target.key} target={target} />}
    </SettingsPageContainer>
  );
}

/** An environment whose folders or their owners haven't arrived: loading, or failed with a retry. */
function FoldersStatus(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string | undefined;
}) {
  const input = { environmentId: props.environmentId, input: {} };
  const folders = useEnvironmentQuery(signalboxFolders.snapshot(input));
  const owners = useEnvironmentQuery(signalboxContexts.snapshot(input));
  const error = folders.error ?? owners.error;
  const where = props.label ? ` on ${props.label}` : "";
  if (error === null) {
    return (
      <SettingsRow
        title={
          <span className="inline-flex items-center gap-2">
            <Spinner size="sm" tone="muted" />
            {`Loading your folders${where}`}
          </span>
        }
      />
    );
  }
  return (
    <SettingsRow
      title={`Could not load your folders${where}`}
      status={
        <span role="alert" className="text-destructive">
          {error}
        </span>
      }
      control={
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            if (folders.error !== null) folders.refresh();
            if (owners.error !== null) owners.refresh();
          }}
        >
          Try again
        </Button>
      }
    />
  );
}

interface OwnerGroup {
  readonly key: string;
  readonly label: string;
  readonly targets: ReadonlyArray<BlockLibraryTarget>;
}

/** The picker's sections: one per owner, named with its environment when there are several. */
function groupByOwner(
  targets: ReadonlyArray<BlockLibraryTarget>,
  environmentLabels: ReadonlyMap<EnvironmentId, string> | null,
): ReadonlyArray<OwnerGroup> {
  const groups = new Map<string, { label: string; targets: Array<BlockLibraryTarget> }>();
  for (const target of targets) {
    const key = `${target.environmentId}:${target.ownerId}`;
    const environment = environmentLabels?.get(target.environmentId);
    const group = groups.get(key) ?? {
      label: environment ? `${target.ownerName} · ${environment}` : target.ownerName,
      targets: [],
    };
    group.targets.push(target);
    groups.set(key, group);
  }
  return [...groups].map(([key, group]) => ({ key, ...group }));
}
