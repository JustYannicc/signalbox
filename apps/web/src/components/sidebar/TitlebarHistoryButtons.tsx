/**
 * Back and forward in the fixed titlebar cluster, beside the sidebar toggle,
 * as in the Codex app. They step through the app's route history, the same as
 * the navigation.back/forward shortcuts. Desktop widths only: the cluster's
 * width is reserved through --workspace-titlebar-content-left in
 * AppSidebarLayout, which uses the same breakpoint.
 */
import { useAtomValue } from "@effect/atom-react";
import type { RouterHistory } from "@tanstack/react-router";
import { useRouter } from "@tanstack/react-router";
import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Buttons before the toggle: two controls plus their gap-1 gaps. */
export const TITLEBAR_HISTORY_WIDTH = "2 * (var(--workspace-titlebar-control-size) + 0.25rem)";

function historyIndex(history: RouterHistory): number {
  return history.location.state.__TSR_index ?? 0;
}

/**
 * The router stamps every entry with its stack index. Back is possible above
 * index 0; forward is possible below the highest index reached since the last
 * push (a push drops the forward stack). After a reload, forward entries from
 * before it are not known until visited, so Forward starts disabled.
 */
function useHistoryAvailability() {
  const { history } = useRouter();
  const [position, setPosition] = useState(() => {
    const index = historyIndex(history);
    return { index, maxIndex: index };
  });
  useEffect(
    () =>
      history.subscribe(({ location, action }) => {
        const index = location.state.__TSR_index ?? 0;
        setPosition((previous) => ({
          index,
          maxIndex: action.type === "PUSH" ? index : Math.max(previous.maxIndex, index),
        }));
      }),
    [history],
  );
  return {
    history,
    canGoBack: position.index > 0,
    canGoForward: position.index < position.maxIndex,
  };
}

function HistoryButton(props: {
  label: string;
  shortcut: string | null;
  disabled: boolean;
  onBackdrop: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={props.label}
            disabled={props.disabled}
            onClick={props.onClick}
            size="icon-sm"
            variant={props.onBackdrop ? "media-navigation" : "ghost"}
            className={
              props.onBackdrop
                ? "pointer-events-auto relative top-auto translate-y-0"
                : "pointer-events-auto"
            }
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {props.label}
        {props.shortcut ? ` (${props.shortcut})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}

export function TitlebarHistoryButtons(props: { onBackdrop: boolean }) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { history, canGoBack, canGoForward } = useHistoryAvailability();
  return (
    <>
      <HistoryButton
        label="Back"
        shortcut={shortcutLabelForCommand(keybindings, "navigation.back")}
        disabled={!canGoBack}
        onBackdrop={props.onBackdrop}
        onClick={() => history.back()}
      >
        <ArrowLeftIcon className="size-4" />
      </HistoryButton>
      <HistoryButton
        label="Forward"
        shortcut={shortcutLabelForCommand(keybindings, "navigation.forward")}
        disabled={!canGoForward}
        onBackdrop={props.onBackdrop}
        onClick={() => history.forward()}
      >
        <ArrowRightIcon className="size-4" />
      </HistoryButton>
    </>
  );
}
