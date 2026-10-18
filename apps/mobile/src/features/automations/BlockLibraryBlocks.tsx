import {
  blockContract,
  undeclaredContractLabel,
  UNREADABLE_CONTRACT,
} from "@t3tools/client-runtime/automations/blockContract";
import {
  BLOCK_LIBRARY_EMPTY,
  blockLibraryStatuses,
  blockPermissionsLabel,
  groupBlockLibrary,
  type BlockLibraryTarget,
} from "@t3tools/client-runtime/automations/blockLibrary";
import type { AutomationBlockLibraryEntry } from "@t3tools/contracts";
import type * as Schema from "effect/Schema";
import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { automationState } from "../../state/automations";
import { useEnvironmentQuery } from "../../state/query";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { RUNTIME_MODE_CHOICES } from "../threads/thread-settings-options";

/** What one folder's automations can start by name, grouped by where each block lives. */
export function BlockLibraryBlocks({ target }: { readonly target: BlockLibraryTarget }) {
  const query = useEnvironmentQuery(
    automationState.blocks({
      environmentId: target.environmentId,
      input: { projectId: target.projectId },
    }),
  );
  const blocks = query.data?.blocks;
  const groups = useMemo(
    () => (blocks === undefined ? [] : groupBlockLibrary(target, blocks)),
    [blocks, target],
  );

  if (query.data === null) {
    return query.error === null ? (
      <Text className="px-2 text-foreground-muted">Loading blocks…</Text>
    ) : (
      <SettingsSection title="Could not load blocks" footer={query.error}>
        <SettingsActionRow label="Try again" onPress={query.refresh} />
      </SettingsSection>
    );
  }
  if (groups.length === 0) {
    return <Text className="px-2 text-foreground-muted">{BLOCK_LIBRARY_EMPTY}</Text>;
  }
  return groups.map((group) => (
    <SettingsSection key={group.key} title={group.title}>
      {group.blocks.map((block, index) => (
        <BlockRow key={block.name} block={block} separated={index > 0} />
      ))}
    </SettingsSection>
  ));
}

function permissionsLabel(mode: AutomationBlockLibraryEntry["availability"]["runtimeMode"]) {
  return blockPermissionsLabel(
    mode === null
      ? null
      : (RUNTIME_MODE_CHOICES.find((candidate) => candidate.mode === mode)?.label ?? mode),
  );
}

function BlockRow(props: {
  readonly block: AutomationBlockLibraryEntry;
  readonly separated: boolean;
}) {
  const { block } = props;
  const statuses = blockLibraryStatuses(block.availability);
  return (
    <View
      className={
        props.separated ? "gap-1 border-t border-border-subtle px-4 py-3" : "gap-1 px-4 py-3"
      }
    >
      <Text textRole="body" className="text-foreground">
        {block.name}
        {statuses.length > 0 ? (
          <Text textRole="footnote" className="text-warning-foreground">
            {`  ${statuses.join(" · ")}`}
          </Text>
        ) : null}
      </Text>
      {block.description ? (
        <Text textRole="footnote" className="text-foreground-muted">
          {block.description}
        </Text>
      ) : null}
      <Text textRole="footnote" className="text-foreground-muted">
        {permissionsLabel(block.availability.runtimeMode)}
      </Text>
      <Contract side="input" contract={block.input} />
      <Contract side="output" contract={block.output} />
    </View>
  );
}

function Contract(props: {
  readonly side: "input" | "output";
  readonly contract: Schema.Json | undefined;
}) {
  const [open, setOpen] = useState(false);
  if (props.contract === undefined) {
    return (
      <Text textRole="footnote" className="text-foreground-muted">
        {undeclaredContractLabel(props.side)}
      </Text>
    );
  }
  const label = props.side === "input" ? "input" : "output";
  return (
    <View className="gap-1">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        hitSlop={8}
        onPress={() => setOpen((value) => !value)}
      >
        <Text textRole="footnote" className="text-primary-text">
          {open ? `Hide ${label}` : `Show ${label}`}
        </Text>
      </Pressable>
      {open ? <ContractCode contract={props.contract} /> : null}
    </View>
  );
}

function ContractCode({ contract }: { readonly contract: Schema.Json }) {
  const view = useMemo(() => blockContract(contract), [contract]);
  return view._tag === "Declared" ? (
    <Text
      className="rounded-lg bg-sheet p-2 font-mono text-[11px] leading-normal text-foreground"
      selectable
    >
      {view.code}
    </Text>
  ) : (
    <Text textRole="footnote" className="text-foreground-muted">
      {UNREADABLE_CONTRACT}
    </Text>
  );
}
