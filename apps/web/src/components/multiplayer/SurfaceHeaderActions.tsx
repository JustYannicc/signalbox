/**
 * The header's panel toggles for chat surfaces that aren't real threads yet
 * (shared chats and tasks, the assistant, agents and rooms), matching the
 * chat header: Thread details, terminal and right panel. Everything else
 * (Open in, Actions, options) lives in the Thread details card
 * (`SurfaceDetails`). The terminal and the `"project"` right panel open the
 * bound project's real thread view with that thing already open
 * (`useOpenInProjectThread`); the right panel toggle can instead drive a page's
 * own side panel (Trace on the assistant and agent pages). Put
 * `SURFACE_HEADER_CONTAINER` on the page header so the access bar collapses
 * with its width, like the chat header does.
 */
import { PanelLayoutControls } from "../chat/PanelLayoutControls";
import { useBoundProject, type SurfaceDetails } from "./SurfaceDetails";
import type { LevelKey } from "../levels/levels";
import { useOpenInProjectThread } from "./useOpenInProjectThread";

export const SURFACE_HEADER_CONTAINER = "@container/surface-header";

const NO_PROJECT = "No project on this computer for this folder";
const noop = () => {};

export function SurfaceHeaderActions(props: {
  /** The surface's Thread details card; shows its toggle. */
  details?: SurfaceDetails;
  /** The surface's level, whose real project the panels open in. */
  level?: LevelKey | null;
  /** Show the terminal toggle. Rooms run nothing, so they leave it out. */
  terminal?: boolean;
  /**
   * `"project"` opens the bound project's thread with its right panel; an object with `open`
   * drives the page's own side panel; `unavailable` says why there is none.
   */
  rightPanel:
    | "project"
    | { open: boolean; onOpenChange: (open: boolean) => void; label: string }
    | { unavailable: string };
}) {
  const { details, rightPanel } = props;
  const project = useBoundProject(props.level);
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
    <div ref={details?.anchorRef} className="flex shrink-0 items-center">
      <PanelLayoutControls
        showThreadPanelControl={details !== undefined}
        threadPanelOpen={details?.open ?? false}
        threadPanelPresentation={details?.presentation ?? "inline"}
        {...(details ? { threadPanelPopoverHandle: details.handle } : {})}
        threadPanelShortcutLabel={details?.shortcutLabel ?? null}
        onToggleThreadPanel={details?.toggle ?? noop}
        showTerminalControl={props.terminal ?? false}
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
        onToggleTerminal={() => void openInProject("terminal")}
        onToggleRightPanel={() =>
          ownPanel ? ownPanel.onOpenChange(!ownPanel.open) : void openInProject("right-panel")
        }
      />
    </div>
  );
}
