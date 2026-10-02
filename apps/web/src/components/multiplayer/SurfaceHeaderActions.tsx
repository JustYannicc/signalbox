/**
 * The thread header's project controls (Actions, Open in, terminal, right
 * panel) for chat surfaces that aren't real threads yet: shared chats and
 * tasks, the assistant, agents and rooms. Their items have no project of their
 * own, so they bind to the most recently active real project. Open in is the
 * real picker on that project's root; Actions, the terminal and the right
 * panel open that project's real thread view with the thing already open
 * (`useOpenInProjectThread`). The right panel toggle can instead drive a
 * page's own side panel (Trace on the assistant and agent pages). Put
 * `SURFACE_HEADER_CONTAINER` on the page header so labels and collapsing
 * follow its width, like the chat header does.
 */
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useAtomValue } from "@effect/atom-react";
import { ChevronDownIcon, PlayIcon, SquareArrowOutUpRightIcon } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { useProjects, useThreadShells } from "../../state/entities";
import {
  primaryServerAvailableEditorsAtom,
  primaryServerKeybindingsAtom,
} from "../../state/server";
import { OpenInPicker } from "../chat/OpenInPicker";
import { PanelLayoutControls } from "../chat/PanelLayoutControls";
import { sortScopedProjectsForSidebar } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useOpenInProjectThread } from "./useOpenInProjectThread";

export const SURFACE_HEADER_CONTAINER = "@container/surface-header";

const LABEL = "sr-only @3xl/surface-header:not-sr-only @3xl/surface-header:ml-0.5";
const NO_PROJECT = "Add a project first";

/** The most recently active real project, the one "/" used to land in. */
function useBoundProject(): EnvironmentProject | null {
  const projects = useProjects();
  const threads = useThreadShells();
  return useMemo(
    () => sortScopedProjectsForSidebar(projects, threads, "updated_at")[0] ?? null,
    [projects, threads],
  );
}

function BoundOpenInPicker(props: { project: EnvironmentProject }) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);
  return (
    <Hint label={`Open ${props.project.title} in an editor`}>
      <OpenInPicker
        environmentId={props.project.environmentId}
        keybindings={keybindings}
        availableEditors={availableEditors}
        openInCwd={props.project.workspaceRoot}
        // The real thread view owns the global open-in-editor shortcut.
        enableShortcut={false}
      />
    </Hint>
  );
}

function Hint(props: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0" />}>{props.children}</TooltipTrigger>
      <TooltipPopup side="bottom">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

export function SurfaceHeaderActions(props: {
  /** Show Actions, Open in and the terminal. Rooms run nothing, so they leave them out. */
  projectControls?: boolean;
  /**
   * `"project"` opens the bound project's thread with its right panel; an object with `open`
   * drives the page's own side panel; `unavailable` says why there is none.
   */
  rightPanel:
    | "project"
    | { open: boolean; onOpenChange: (open: boolean) => void; label: string }
    | { unavailable: string };
}) {
  const { projectControls, rightPanel } = props;
  const project = useBoundProject();
  const openInProject = useOpenInProjectThread(project);
  const projectName = project?.title ?? null;
  const ownPanel = typeof rightPanel === "object" && "open" in rightPanel ? rightPanel : null;
  const panelLabels =
    rightPanel === "project"
      ? projectName
        ? { rightPanelLabel: `Open the right panel in ${projectName}` }
        : { rightPanelUnavailableLabel: NO_PROJECT }
      : "open" in rightPanel
        ? { rightPanelLabel: rightPanel.label }
        : { rightPanelUnavailableLabel: rightPanel.unavailable };

  return (
    <div className="flex shrink-0 items-center gap-2">
      {projectControls ? (
        // The chat header folds these into its ⋯ menu when narrow; here they just step aside.
        <div className="flex shrink-0 items-center gap-2 @max-lg/surface-header:hidden">
          <Hint label={projectName ? `Open actions in ${projectName}` : NO_PROJECT}>
            <Button
              size="xs"
              variant="outline"
              className="w-7 sm:w-6 @3xl/surface-header:w-auto!"
              aria-label="Actions"
              disabled={!project}
              onClick={() => void openInProject("thread")}
            >
              <PlayIcon className="size-3.5" />
              <span className={LABEL}>Actions</span>
            </Button>
          </Hint>
          {project ? (
            <BoundOpenInPicker project={project} />
          ) : (
            <Hint label={NO_PROJECT}>
              <Group aria-label="Open in editor">
                <Button size="xs" variant="outline" aria-label="Open in editor" disabled>
                  <SquareArrowOutUpRightIcon aria-hidden className="size-3.5" />
                  <span className={LABEL}>Open</span>
                </Button>
                <GroupSeparator className="hidden @3xl/surface-header:block" />
                <Button aria-label="Choose editor" size="icon-xs" variant="outline" disabled>
                  <ChevronDownIcon aria-hidden className="size-4" />
                </Button>
              </Group>
            </Hint>
          )}
        </div>
      ) : null}
      <PanelLayoutControls
        showTerminalControl={projectControls ?? false}
        terminalAvailable={project !== null}
        terminalOpen={false}
        terminalShortcutLabel={null}
        {...(projectName
          ? { terminalLabel: `Open terminal in ${projectName}` }
          : { terminalUnavailableLabel: NO_PROJECT })}
        rightPanelAvailable={ownPanel !== null || (rightPanel === "project" && project !== null)}
        rightPanelOpen={ownPanel?.open ?? false}
        rightPanelShortcutLabel={null}
        {...panelLabels}
        liveAgentCount={0}
        onToggleTerminal={() => void openInProject("terminal")}
        onToggleRightPanel={() =>
          ownPanel ? ownPanel.onOpenChange(!ownPanel.open) : void openInProject("right-panel")
        }
      />
    </div>
  );
}
