/**
 * Live level options for a surface. Wrap a page (or a popup) in
 * `LevelOptionsProvider` once, then read `useLevelOptionsContext()` or
 * `useLevelLabel()` in rows, so a long list doesn't rebuild the projects per
 * row. Without a provider, readers get sections and team projects only.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { selectProjectGroupingSettings } from "../../logicalProject";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useAssistantIdentity } from "../assistant/assistantIdentity";
import { allHomeSections } from "../sidebar/sections/sectionModel";
import { useHomeSectionStore } from "../sidebar/sections/sectionStore";
import { levelLabel, TOP_LEVEL, type LevelKey } from "./levels";
import { buildLevelOptions, type LevelOption, type LevelProject } from "./levelOptions";

const NO_PROJECTS: readonly LevelProject[] = [];
const LevelOptionsContext = createContext<readonly LevelOption[] | null>(null);

function useSectionLevelOptions(projects: readonly LevelProject[]) {
  // Cached by `allHomeSections`, so this only changes when sections do.
  const sections = useHomeSectionStore(() => allHomeSections());
  const projectSectionOverrides = useHomeSectionStore((state) => state.projectSectionOverrides);
  const names = useHomeSectionStore((state) => state.names);
  return useMemo(
    () => buildLevelOptions({ sections, projects, placement: { projectSectionOverrides, names } }),
    [names, projectSectionOverrides, projects, sections],
  );
}

/** Every level, real projects included. Prefer the provider over calling this per row. */
export function useLevelOptions(): readonly LevelOption[] {
  const projects = useProjects();
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const levelProjects = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects,
        settings: groupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: () => null,
      }).map(({ projectKey, displayName, workspaceRoot }) => ({
        projectKey,
        displayName,
        workspaceRoot,
      })),
    [groupingSettings, primaryEnvironmentId, projects],
  );
  return useSectionLevelOptions(levelProjects);
}

export function LevelOptionsProvider(props: { children: ReactNode }) {
  const options = useLevelOptions();
  return <LevelOptionsContext value={options}>{props.children}</LevelOptionsContext>;
}

export function useLevelOptionsContext(): readonly LevelOption[] {
  const provided = useContext(LevelOptionsContext);
  const fallback = useSectionLevelOptions(NO_PROJECTS);
  return provided ?? fallback;
}

/** Folder path for a level key, e.g. "Work › Northwind team". */
export function useLevelLabel(): (key: LevelKey) => string {
  const options = useLevelOptionsContext();
  return useMemo(() => {
    const byKey = new Map(options.map((option) => [option.key, option.label] as const));
    return (key) => byKey.get(key) ?? levelLabel(key);
  }, [options]);
}

/** The agent that represents a level: its section or project agent, or the assistant at the top. */
export function useLevelAgentName(): (key: LevelKey) => string {
  const options = useLevelOptionsContext();
  const { name: assistantName } = useAssistantIdentity();
  return useMemo(() => {
    const byKey = new Map(options.map((option) => [option.key, option.agentName] as const));
    return (key) =>
      key === TOP_LEVEL
        ? assistantName
        : (byKey.get(key) ?? (key.startsWith("section:") ? "Section agent" : "Project agent"));
  }, [assistantName, options]);
}
