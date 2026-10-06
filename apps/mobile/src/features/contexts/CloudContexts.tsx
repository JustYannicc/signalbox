/**
 * Signalbox Cloud contexts at the top of Home: Personal and every work
 * organization, each with the sections the user arranged on any client.
 * Read-only here; sections are created and rearranged on web and desktop.
 * Renders nothing until a cloud environment is connected.
 */
import {
  buildContextTrees,
  type SectionNode,
} from "@t3tools/client-runtime/state/signalboxContexts";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";
import { View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useCloudEnvironmentIds, useContextsSnapshot } from "../../state/signalboxContexts";
import { ThreadListV2SectionDivider } from "../threads/thread-list-v2-items";

/** Row inset matching the list's section dividers, plus this much per nesting level. */
const ROW_INSET = 20;
const DEPTH_INDENT = 14;

function SectionRows(props: { nodes: ReadonlyArray<SectionNode>; depth: number }) {
  return props.nodes.map((node) => (
    <View key={node.section.id}>
      <View
        accessibilityRole="text"
        className="min-h-9 flex-row items-center gap-2.5 pr-5"
        style={{ paddingLeft: ROW_INSET + props.depth * DEPTH_INDENT }}
      >
        <SymbolView
          name="folder"
          size={14}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
        <Text numberOfLines={1} className="flex-1 text-sm text-foreground">
          {node.section.name}
        </Text>
      </View>
      <SectionRows nodes={node.children} depth={props.depth + 1} />
    </View>
  ));
}

function EnvironmentContexts(props: { environmentId: EnvironmentId }) {
  const snapshot = useContextsSnapshot(props.environmentId);
  const trees = useMemo(() => (snapshot ? buildContextTrees(snapshot) : []), [snapshot]);
  return trees.map((tree) => (
    <View key={tree.context.id} accessibilityLabel={tree.context.name}>
      <ThreadListV2SectionDivider label={tree.context.name} />
      <SectionRows nodes={tree.sections} depth={0} />
    </View>
  ));
}

export function CloudContexts() {
  const environmentIds = useCloudEnvironmentIds();
  if (environmentIds.length === 0) return null;
  return (
    <View className="w-full">
      {environmentIds.map((environmentId) => (
        <EnvironmentContexts key={environmentId} environmentId={environmentId} />
      ))}
    </View>
  );
}
