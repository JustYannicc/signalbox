import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useMemo, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText } from "../../components/AppText";
import { MaterialIconButton } from "../../components/MaterialIconButton";
import { SymbolView } from "../../components/AppSymbol";
import { useEnvironmentServerConfig, useProjects } from "../../state/entities";
import { environmentSections } from "../../state/sections";
import type { SectionNavigationEnvironment } from "./sectionNavigationTypes";
import { SectionNodeRow, ProjectRow } from "./SectionNavigationRows";
import { useSectionActions } from "./use-section-actions";
import { ContextSections } from "../contexts/ContextSections"; // signalbox: contexts
import { useEnvironmentContexts } from "../../state/signalboxContexts"; // signalbox: contexts

export function SectionNavigationPanel(props: {
  readonly environments: ReadonlyArray<SectionNavigationEnvironment>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly onClose: () => void;
}) {
  const projects = useProjects();
  const visibleEnvironments = useMemo(
    () =>
      props.environments.filter(
        (environment) =>
          props.selectedEnvironmentId === null ||
          props.selectedEnvironmentId === environment.environmentId,
      ),
    [props.environments, props.selectedEnvironmentId],
  );

  return (
    <View className="mx-3 mb-3 overflow-hidden rounded-2xl border border-border bg-card">
      <View className="flex-row items-center justify-between border-b border-border px-4 py-3">
        <View className="min-w-0 flex-1">
          <AppText
            accessibilityRole="header"
            className="text-base font-t3-semibold text-foreground"
          >
            Sections
          </AppText>
          <AppText className="mt-0.5 text-xs text-foreground-muted">
            Choose a project to show its threads.
          </AppText>
        </View>
        <View className="flex-row items-center gap-1">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Show all threads"
            className="min-h-10 justify-center rounded-full px-3 active:bg-subtle"
            onPress={() => props.onProjectChange(null)}
          >
            <AppText className="text-sm text-primary">All threads</AppText>
          </Pressable>
          <MaterialIconButton
            accessibilityLabel="Hide sections"
            icon="chevron.up"
            onPress={props.onClose}
            variant="tonal"
          />
        </View>
      </View>
      {visibleEnvironments.length === 0 ? (
        <View className="px-4 py-4">
          <AppText className="text-sm text-foreground-muted">
            No environments are available for sections yet.
          </AppText>
        </View>
      ) : (
        visibleEnvironments.map((environment) => (
          <SectionTreeEnvironment
            key={environment.environmentId}
            environment={environment}
            environmentCount={visibleEnvironments.length}
            projects={projects}
            selectedProjectKey={props.selectedProjectKey}
            onProjectChange={props.onProjectChange}
          />
        ))
      )}
    </View>
  );
}

function SectionTreeEnvironment(props: {
  readonly environment: SectionNavigationEnvironment;
  readonly environmentCount: number;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly selectedProjectKey: string | null;
  readonly onProjectChange: (projectKey: string | null) => void;
}) {
  const environmentId = props.environment.environmentId;
  const snapshot = useAtomValue(environmentSections.snapshotAtom(environmentId));
  const sectionsState = useAtomValue(environmentSections.stateAtom(environmentId));
  const tree = useAtomValue(environmentSections.treeAtom(environmentId));
  const retrySections = useAtomSet(environmentSections.retry);
  const config = useEnvironmentServerConfig(environmentId);
  const sectionsSupported = config?.environment.capabilities.sections === true;
  const environmentProjects = useMemo(
    () => props.projects.filter((project) => project.environmentId === environmentId),
    [environmentId, props.projects],
  );
  const rootProjects = sectionsSupported
    ? [...tree.rootProjects, ...tree.unplacedProjects]
    : tree.unplacedProjects;
  const contexts = useEnvironmentContexts(environmentId); // signalbox: contexts
  const { requestCreateSection, onProjectAction, onSectionAction } = useSectionActions({
    environmentId,
    snapshot,
    projects: environmentProjects,
    contexts, // signalbox: contexts
  });
  const [collapsedSections, setCollapsedSections] = useState<ReadonlySet<string>>(() => new Set());
  const toggleSection = useCallback((sectionId: string) => {
    setCollapsedSections((current) => {
      const next = new Set(current);
      if (next.has(sectionId)) next.delete(sectionId);
      else next.add(sectionId);
      return next;
    });
  }, []);

  return (
    <View className="border-b border-border last:border-b-0">
      {props.environmentCount > 1 || sectionsSupported ? (
        <View className="flex-row items-center justify-between px-4 pt-3 pb-1">
          <AppText className="text-xs font-t3-semibold uppercase tracking-wide text-foreground-muted">
            {props.environmentCount > 1 ? props.environment.label : "Projects"}
          </AppText>
          {sectionsSupported ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Create section in ${props.environment.label}`}
              className="min-h-9 flex-row items-center gap-1 rounded-full px-2 active:bg-subtle"
              onPress={() => requestCreateSection(null)}
            >
              <SymbolView name="plus" size={14} tintColorClassName="accent-primary" />
              <AppText className="text-sm text-primary">New section</AppText>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {!sectionsSupported ? (
        <AppText className="px-4 py-2 text-xs text-foreground-muted">
          Sections aren’t available on this connection yet.
        </AppText>
      ) : null}
      {sectionsSupported && sectionsState._tag === "Failure" ? (
        <View className="flex-row items-center gap-3 border-b border-border px-4 py-3">
          <View className="min-w-0 flex-1">
            <AppText className="text-sm font-t3-medium text-foreground">
              Couldn’t load sections
            </AppText>
            <AppText className="mt-0.5 text-xs text-foreground-muted" numberOfLines={2}>
              {sectionsState.error}
            </AppText>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Retry loading sections for ${props.environment.label}`}
            className="min-h-10 justify-center rounded-full bg-subtle px-4 active:bg-subtle-strong"
            onPress={() => retrySections(environmentId)}
          >
            <AppText className="text-sm font-t3-medium text-primary">Retry</AppText>
          </Pressable>
        </View>
      ) : null}
      {sectionsSupported && sectionsState._tag === "Loading" && snapshot === null ? (
        <AppText className="px-4 py-2 text-xs text-foreground-muted">Loading sections…</AppText>
      ) : null}
      {sectionsSupported && snapshot !== null && snapshot.sections.length === 0 ? (
        <AppText className="px-4 py-2 text-xs text-foreground-muted">
          Projects without a section stay at the top level.
        </AppText>
      ) : null}
      {/* signalbox: a cloud environment groups its sections by context */}
      <ContextSections
        contexts={contexts}
        roots={sectionsSupported ? tree.roots : []}
        projects={rootProjects}
        tree={tree}
        onCreateSection={(contextId) => requestCreateSection(null, contextId)}
        renderSection={(node) => (
          <SectionNodeRow
            key={node.section.id}
            node={node}
            depth={0}
            ancestorPath=""
            environmentId={environmentId}
            snapshot={snapshot}
            selectedProjectKey={props.selectedProjectKey}
            collapsedSections={collapsedSections}
            onProjectChange={props.onProjectChange}
            onToggle={toggleSection}
            onSectionAction={onSectionAction}
            onProjectAction={onProjectAction}
          />
        )}
        renderProjects={(groupProjects, contextId) =>
          groupProjects.map((project, siblingIndex) => (
            <ProjectRow
              key={project.id}
              project={project}
              environmentId={environmentId}
              depth={0}
              siblingIndex={siblingIndex}
              siblingCount={groupProjects.length}
              sectionId={null}
              sectionPath=""
              snapshot={sectionsSupported ? snapshot : null}
              {...(contextId === undefined ? {} : { contextId })}
              selectedProjectKey={props.selectedProjectKey}
              onSelect={props.onProjectChange}
              onAction={onProjectAction}
            />
          ))
        }
      />
    </View>
  );
}
