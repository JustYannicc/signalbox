import type { SectionTreeNode } from "@t3tools/client-runtime/state/sections";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { Section, SectionId, SectionsSnapshot } from "@t3tools/contracts/sections";
import { useCallback, useMemo } from "react";
import { Pressable, View } from "react-native";

import { AppText } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { SymbolView } from "../../components/AppSymbol";
import { sectionProjectFilterKey } from "./section-project-filter";
import { projectMoveMenuActions, sectionMenuActions } from "./section-navigation-model";

export type SectionProject = { readonly id: ProjectId; readonly title: string };
const MAX_VISUAL_DEPTH = 5;

export interface SectionNavigationRowProps {
  readonly environmentId: EnvironmentId;
  readonly snapshot: SectionsSnapshot | null;
  readonly selectedProjectKey: string | null;
  readonly collapsedSections: ReadonlySet<string>;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly onToggle: (sectionId: string) => void;
  readonly onSectionAction: (section: Section, event: string) => void;
  readonly onProjectAction: (projectId: ProjectId, event: string) => void;
  /** signalbox: pools a section's new threads can default to. */
  readonly pools: ReadonlyArray<{ readonly id: string; readonly name: string }>;
}

export function SectionNodeRow(
  props: SectionNavigationRowProps & {
    readonly node: SectionTreeNode<SectionProject>;
    readonly depth: number;
    readonly ancestorPath: string;
  },
) {
  const section = props.node.section;
  const sectionPath = props.ancestorPath ? `${props.ancestorPath} / ${section.name}` : section.name;
  const onSectionAction = props.onSectionAction;
  const collapsed = props.collapsedSections.has(section.id);
  const sectionActions = useMemo(
    () =>
      props.snapshot === null
        ? []
        : sectionMenuActions({ section, snapshot: props.snapshot, pools: props.pools }),
    [props.pools, props.snapshot, section],
  );
  const handleSectionMenuAction = useCallback(
    (event: { readonly nativeEvent: { readonly event: string } }) =>
      onSectionAction(section, event.nativeEvent.event),
    [onSectionAction, section],
  );

  return (
    <View>
      <View
        className="flex-row items-center pr-2"
        style={{ paddingLeft: 12 + Math.min(props.depth, MAX_VISUAL_DEPTH) * 18 }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Section ${sectionPath}`}
          accessibilityState={{ expanded: !collapsed }}
          className="min-h-11 min-w-0 flex-1 flex-row items-center gap-2 active:opacity-75"
          onPress={() => props.onToggle(section.id)}
        >
          <View className="size-10 items-center justify-center">
            <SymbolView
              name={collapsed ? "chevron.right" : "chevron.down"}
              size={14}
              tintColorClassName="accent-icon-muted"
            />
          </View>
          <SymbolView name="folder" size={16} tintColorClassName="accent-icon-muted" />
          <AppText className="min-w-0 flex-1 font-t3-medium text-foreground" numberOfLines={1}>
            {section.name}
          </AppText>
          <AppText className="text-xs text-foreground-muted">
            {props.node.projects.length + props.node.childSections.length}
          </AppText>
        </Pressable>
        {sectionActions.length > 0 ? (
          <ControlPillMenu
            actions={sectionActions}
            onPressAction={handleSectionMenuAction}
            title={sectionPath}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Actions for ${sectionPath}`}
              className="size-10 items-center justify-center rounded-full active:bg-subtle"
            >
              <SymbolView name="ellipsis" size={16} tintColorClassName="accent-icon-muted" />
            </Pressable>
          </ControlPillMenu>
        ) : null}
      </View>
      {collapsed ? null : (
        <View>
          {props.node.childSections.map((child) => (
            <SectionNodeRow
              key={child.section.id}
              {...props}
              node={child}
              depth={props.depth + 1}
              ancestorPath={sectionPath}
            />
          ))}
          {props.node.projects.map((project, siblingIndex) => (
            <ProjectRow
              key={project.id}
              project={project}
              environmentId={props.environmentId}
              depth={props.depth + 1}
              siblingIndex={siblingIndex}
              siblingCount={props.node.projects.length}
              sectionId={section.id}
              sectionPath={sectionPath}
              snapshot={props.snapshot}
              selectedProjectKey={props.selectedProjectKey}
              onSelect={props.onProjectChange}
              onAction={props.onProjectAction}
            />
          ))}
        </View>
      )}
    </View>
  );
}

export function ProjectRow(props: {
  readonly project: SectionProject;
  readonly environmentId: EnvironmentId;
  readonly depth: number;
  readonly siblingIndex: number;
  readonly siblingCount: number;
  readonly sectionId: SectionId | null;
  readonly sectionPath: string;
  readonly snapshot: SectionsSnapshot | null;
  /** signalbox: a top-level project's cloud context. */
  readonly contextId?: string;
  readonly selectedProjectKey: string | null;
  readonly onSelect: (projectKey: string | null) => void;
  readonly onAction: (projectId: ProjectId, event: string) => void;
}) {
  const projectId = props.project.id;
  const onAction = props.onAction;
  const selected =
    props.selectedProjectKey ===
    sectionProjectFilterKey({ environmentId: props.environmentId, projectId });
  const actions = useMemo(
    () =>
      props.snapshot === null
        ? []
        : projectMoveMenuActions({
            snapshot: props.snapshot,
            sectionId: props.sectionId,
            siblingIndex: props.siblingIndex,
            siblingCount: props.siblingCount,
            ...(props.contextId === undefined ? {} : { contextId: props.contextId }),
          }),
    [props.contextId, props.sectionId, props.siblingCount, props.siblingIndex, props.snapshot],
  );
  const handleMenuAction = useCallback(
    (event: { readonly nativeEvent: { readonly event: string } }) =>
      onAction(projectId, event.nativeEvent.event),
    [onAction, projectId],
  );
  const projectKey = sectionProjectFilterKey({
    environmentId: props.environmentId,
    projectId,
  });
  return (
    <View
      className={selected ? "flex-row items-center bg-subtle" : "flex-row items-center"}
      style={{ paddingLeft: 42 + Math.min(props.depth, MAX_VISUAL_DEPTH) * 18, paddingRight: 8 }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Show threads in ${props.sectionPath ? `${props.sectionPath} / ` : ""}${props.project.title}`}
        accessibilityState={{ selected }}
        className="min-h-11 min-w-0 flex-1 flex-row items-center gap-2 py-1 active:opacity-75"
        onPress={() => props.onSelect(projectKey)}
      >
        <SymbolView name="folder" size={15} tintColorClassName="accent-icon-muted" />
        <AppText className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
          {props.project.title}
        </AppText>
        {selected ? (
          <SymbolView name="checkmark" size={15} tintColorClassName="accent-primary" />
        ) : null}
      </Pressable>
      {actions.length > 0 ? (
        <ControlPillMenu
          actions={actions}
          onPressAction={handleMenuAction}
          title={`${props.sectionPath ? `${props.sectionPath} / ` : ""}${props.project.title}`}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Move ${props.sectionPath ? `${props.sectionPath} / ` : ""}${props.project.title}`}
            className="size-10 items-center justify-center rounded-full active:bg-subtle-strong"
          >
            <SymbolView name="ellipsis" size={16} tintColorClassName="accent-icon-muted" />
          </Pressable>
        </ControlPillMenu>
      ) : null}
    </View>
  );
}
