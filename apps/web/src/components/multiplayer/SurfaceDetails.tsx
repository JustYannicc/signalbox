/**
 * Thread details for chat surfaces that aren't real threads yet (shared chats
 * and tasks, rooms, the assistant, agents): the same card `ChatView` shows,
 * fed by fixtures. `useSurfaceDetails(key)` owns the card's open state (the
 * real right panel store, under a synthetic thread ref) and the
 * `threadPanel.toggle` shortcut. Hand it to `SurfaceHeaderActions` for the
 * header toggle and to `SurfaceDetailsCard` for the card. Inside a
 * `ChatCanvas` the card sits beside the conversation like main's; elsewhere it
 * drops from the header toggle.
 *
 * Workspace binds to the real project behind the surface's level (a team
 * project or real project with that name on this computer): Open in is the
 * real picker on its root, and Actions opens that project's real thread view
 * (`useOpenInProjectThread`). Section-level surfaces have no project.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { FolderIcon, PlayIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { isElectron } from "../../env";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../../keybindings";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { cn } from "../../lib/utils";
import type { ThreadPanelPresentation } from "../../rightPanelLayout";
import { selectThreadPanelOpen, useRightPanelStore } from "../../rightPanelStore";
import { useProjects, useThreadShells } from "../../state/entities";
import {
  primaryServerAvailableEditorsAtom,
  primaryServerKeybindingsAtom,
} from "../../state/server";
import { OpenInPicker } from "../chat/OpenInPicker";
import { ThreadDetailsCard } from "../chat/ThreadDetailsCard";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { ThreadDetailsSection } from "../chat/ThreadDetailsSection";
import { LevelSection } from "../chat/ThreadLevelSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
} from "../chat/threadDetailsPanelStyles";
import type { LevelKey } from "../levels/levels";
import { TEAM_PROJECTS } from "./multiplayerFixtures";
import { sortScopedProjectsForSidebar } from "../Sidebar.logic";
import { PopoverCreateHandle } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useOpenInProjectThread } from "./useOpenInProjectThread";

const SURFACE_ENVIRONMENT_ID = EnvironmentId.make("signalbox-surface");

/** The real project behind a level: the project itself, or one named like the team project. */
export function useBoundProject(level: LevelKey | null | undefined): EnvironmentProject | null {
  const projects = useProjects();
  const threads = useThreadShells();
  return useMemo(() => {
    if (!level) return null;
    const name = level.startsWith("team-project:")
      ? (TEAM_PROJECTS.find((project) => project.id === level.slice(13))?.name ?? level.slice(13))
      : null;
    const sorted = sortScopedProjectsForSidebar(projects, threads, "updated_at");
    return (
      sorted.find((project) => {
        if (level === `project:${project.environmentId}:${project.id}`) return true;
        if (!name) return false;
        const folder = project.workspaceRoot.split(/[\\/]/).findLast(Boolean) ?? "";
        return project.title === name || folder === name;
      }) ?? null
    );
  }, [level, projects, threads]);
}

export type SurfaceDetails = ReturnType<typeof useSurfaceDetails>;

/** Open state, popover plumbing and the mod+shift+b shortcut for one surface's card. */
export function useSurfaceDetails(surfaceKey: string) {
  const threadRef = useMemo(
    () => scopeThreadRef(SURFACE_ENVIRONMENT_ID, ThreadId.make(`surface:${surfaceKey}`)),
    [surfaceKey],
  );
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const [handle] = useState(PopoverCreateHandle);
  const [presentation, setPresentation] = useState<ThreadPanelPresentation>("inline");
  const open = useRightPanelStore((state) =>
    selectThreadPanelOpen(state.threadPanelVisibilityByThreadKey, threadRef, presentation),
  );
  const toggle = useCallback(
    () => useRightPanelStore.getState().toggleThreadPanel(threadRef, presentation),
    [threadRef, presentation],
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isCommandPaletteOpen()) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: false,
          previewFocus: false,
          previewOpen: false,
          modelPickerOpen: false,
          isWeb: !isElectron,
          isDesktop: isElectron,
        },
      });
      if (command !== "threadPanel.toggle") return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) toggle();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [keybindings, toggle]);
  return {
    threadRef,
    anchorRef,
    handle,
    presentation,
    setPresentation,
    open,
    toggle,
    shortcutLabel: shortcutLabelForCommand(keybindings, "threadPanel.toggle"),
  };
}

function WorkspaceSection(props: { project: EnvironmentProject | null }) {
  const { project } = props;
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);
  const openInProject = useOpenInProjectThread(project);
  if (!project) {
    return (
      <ThreadDetailsSection
        headingId="surface-details-workspace-heading"
        title="Workspace"
        separated={false}
      >
        <p className="px-1.5 text-xs text-muted-foreground">
          No project on this computer for this folder yet.
        </p>
      </ThreadDetailsSection>
    );
  }
  return (
    <ThreadDetailsSection
      headingId="surface-details-workspace-heading"
      title="Workspace"
      separated={false}
      showHeading={false}
    >
      <div className="flex flex-col">
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                className={cn("inline-flex items-center", THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS)}
              />
            }
          >
            <FolderIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
            <span className={cn("min-w-0 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
              {project.title}
            </span>
          </TooltipTrigger>
          <TooltipPopup side="left">{project.workspaceRoot}</TooltipPopup>
        </Tooltip>
        <OpenInPicker
          environmentId={project.environmentId}
          keybindings={keybindings}
          availableEditors={availableEditors}
          openInCwd={project.workspaceRoot}
          displayMode="panel"
          // The real thread view owns the global open-in-editor shortcut.
          enableShortcut={false}
        />
        <ThreadDetailsControl
          size="xs"
          variant="ghost"
          aria-label={`Open actions in ${project.title}`}
          onClick={() => void openInProject("thread")}
        >
          <PlayIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          <span className={cn("min-w-0 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>Actions</span>
        </ThreadDetailsControl>
      </div>
    </ThreadDetailsSection>
  );
}

/**
 * The card: Workspace (when the surface runs things), its Level, then the
 * surface's own sections (reply mode, archive, lineage...).
 */
export function SurfaceDetailsCard(props: {
  details: SurfaceDetails;
  /** Omitted when the surface isn't placed in Home. */
  level?: LevelKey | null;
  /** Rooms only talk, so they leave Workspace out. */
  workspace?: boolean;
  children?: ReactNode;
}) {
  const { details } = props;
  const project = useBoundProject(props.level);
  return (
    <ThreadDetailsCard
      threadRef={details.threadRef}
      anchor={details.anchorRef}
      handle={details.handle}
      onPresentationChange={details.setPresentation}
    >
      {() => (
        <>
          {props.workspace ? <WorkspaceSection project={project} /> : null}
          {props.level ? (
            <LevelSection level={props.level} separated={props.workspace === true} />
          ) : null}
          {props.children}
        </>
      )}
    </ThreadDetailsCard>
  );
}
