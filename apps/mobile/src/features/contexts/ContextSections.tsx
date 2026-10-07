/**
 * One environment's section tree. Signalbox Cloud groups it by context:
 * Personal and every work organization, each with its own sections and
 * projects. Other environments show the plain tree.
 */
import { groupSectionTreeByContext } from "@t3tools/client-runtime/state/signalboxContexts";
import type { SectionTree, SectionTreeNode } from "@t3tools/client-runtime/state/sections";
import type { ProjectId } from "@t3tools/contracts";
import type { SignalboxContextsSnapshot } from "@t3tools/contracts/signalboxContexts";
import { useMemo, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText } from "../../components/AppText";

export function ContextSections<Project extends { readonly id: ProjectId }>(props: {
  readonly contexts: SignalboxContextsSnapshot | null;
  readonly tree: SectionTree<Project>;
  /** The plain tree's top level, for environments without contexts. */
  readonly roots: ReadonlyArray<SectionTreeNode<Project>>;
  readonly projects: ReadonlyArray<Project>;
  readonly onCreateSection: (contextId: string) => void;
  readonly renderSection: (node: SectionTreeNode<Project>) => ReactNode;
  readonly renderProjects: (projects: ReadonlyArray<Project>, contextId?: string) => ReactNode;
}) {
  const groups = useMemo(
    () => (props.contexts ? groupSectionTreeByContext(props.tree, props.contexts) : null),
    [props.contexts, props.tree],
  );
  if (!groups) {
    return (
      <>
        {props.roots.map((node) => props.renderSection(node))}
        {props.renderProjects(props.projects)}
      </>
    );
  }
  return groups.map(({ context, roots, projects }) => (
    <View key={context.id} accessibilityLabel={context.name}>
      <View className="flex-row items-center justify-between px-4 pt-3 pb-1">
        <AppText className="text-xs font-t3-semibold uppercase tracking-wide text-foreground-muted">
          {context.name}
        </AppText>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`New section in ${context.name}`}
          className="min-h-9 flex-row items-center gap-1 rounded-full px-2 active:bg-subtle"
          onPress={() => props.onCreateSection(context.id)}
        >
          <SymbolView name="plus" size={14} tintColorClassName="accent-primary" />
        </Pressable>
      </View>
      {roots.map((node) => props.renderSection(node))}
      {props.renderProjects(projects, context.id)}
    </View>
  ));
}
