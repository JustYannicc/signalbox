/**
 * signalbox: the environment capability a keybinding needs to do anything. Settings hide the
 * row and its search result where no environment has it, the way they hide other rows
 * (`unsupportedSettingsCapabilities`). Undefined: the command works everywhere.
 */
import type { KeybindingCommand, SignalboxEnvironmentCapability } from "@t3tools/contracts";

export function keybindingCapability(
  command: KeybindingCommand,
): SignalboxEnvironmentCapability | undefined {
  // Project scripts run in the terminal drawer.
  if (command.startsWith("terminal.") || command.startsWith("script.")) return "terminal";
  switch (command) {
    case "composer.host":
    case "composer.cycleHost":
      return "otherEnvironments";
    case "composer.workspace":
    case "composer.previousWorktree":
    // Without worktrees a thread's branch is its own, so there is no branch picker to open.
    case "composer.branch":
      return "worktrees";
    case "editor.openFavorite":
      return "localFilesystem";
    default:
      return undefined;
  }
}
