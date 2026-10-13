/**
 * THESIS: the app opens above the work, not inside it. One line about what
 * keeps things moving, one question about what you want, and nothing else
 * competing; projects and threads are the trace, a toggle away.
 * OWN-WORLD: the incumbent Signalbox shell, untouched: card surfaces, muted
 * secondary text, primary for the one action per view. No new tokens.
 * STORY: you open the app, see that ~15 minutes unblocks everything, say what
 * you want today, then either start the pipeline or go do your thing.
 * FIRST VIEWPORT: centered column, assistant face, greeting, the have-to line
 * with Start on its right, then "What do you want to do?" and its input.
 * FORM: pinned by issue #180; no concept roll.
 *
 * UI prototype on placeholder fixtures (issue #180).
 */
import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowLeftIcon, LayoutGridIcon, PanelLeftIcon } from "lucide-react";
import { useCallback, useEffect, type CSSProperties } from "react";

import { isElectron } from "../../env";
import { Button } from "../ui/button";
import { resolveShortcutCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Glance } from "./Glance";
import { OpenScreen } from "./OpenScreen";
import { TurnRunner } from "./TurnRunner";
import { useWorkspaceVisibility } from "./workspaceVisibility";

export type TopLayerView = "open" | "turns" | "glance";

export function validateTopLayerSearch(raw: Record<string, unknown>): { view?: TopLayerView } {
  const view = raw.view;
  return view === "turns" || view === "glance" ? { view } : {};
}

/**
 * The sidebar shortcut (mod+B) reveals the workspace while it's hidden. Once
 * it shows, the sidebar's own control owns the shortcut again.
 */
function useRevealShortcut(enabled: boolean, onReveal: () => void) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (resolveShortcutCommand(event, keybindings, { context: {} }) !== "sidebar.toggle") return;
      event.preventDefault();
      onReveal();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [enabled, keybindings, onReveal]);
}

export function TopLayerPage() {
  const { view = "open" } = useSearch({ from: "/today" });
  const navigate = useNavigate({ from: "/today" });
  const revealed = useWorkspaceVisibility((state) => state.revealed);
  const setRevealed = useWorkspaceVisibility((state) => state.setRevealed);
  const reveal = useCallback(() => setRevealed(true), [setRevealed]);
  useRevealShortcut(!revealed, reveal);
  // Leaving the top layer puts the workspace back out of sight for next time.
  useEffect(() => () => setRevealed(false), [setRevealed]);
  const go = (next: TopLayerView) =>
    void navigate({ search: next === "open" ? {} : { view: next } });

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader
          electron={isElectron}
          // With the workspace hidden there are no titlebar controls to clear,
          // only the window's own (traffic lights on macOS).
          className={revealed ? undefined : "pl-(--workspace-controls-left)"}
          style={
            revealed
              ? undefined
              : ({
                  "--workspace-titlebar-content-left": "var(--workspace-controls-left)",
                } as CSSProperties)
          }
        >
          <div className="flex flex-1 items-center">
            {view === "glance" ? (
              <Button size="sm" variant="ghost-muted" onClick={() => go("open")}>
                <ArrowLeftIcon />
                Now
              </Button>
            ) : null}
          </div>
          {view === "open" ? (
            <Button size="sm" variant="ghost-muted" onClick={() => go("glance")}>
              <LayoutGridIcon />
              Glance
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={revealed ? "secondary" : "ghost-muted"}
            aria-pressed={revealed}
            onClick={() => setRevealed(!revealed)}
          >
            <PanelLeftIcon />
            Workspace
          </Button>
        </WorkspacePageHeader>

        <main className="min-h-0 flex-1 overflow-y-auto">
          {view === "turns" ? (
            <TurnRunner onExit={() => go("open")} />
          ) : view === "glance" ? (
            <Glance onStart={() => go("turns")} />
          ) : (
            <OpenScreen onStart={() => go("turns")} />
          )}
        </main>
      </div>
    </SidebarInset>
  );
}
