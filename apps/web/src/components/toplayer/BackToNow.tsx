/**
 * The way back up: your assistant's face in the titlebar, next to the sidebar
 * toggle, wherever you are in the workspace. One click returns to Now.
 */
import { Link } from "@tanstack/react-router";

import { AssistantIcon } from "../assistant/assistantIdentity";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { TOP_LAYER_PATH } from "./workspaceVisibility";

/** Width the button adds to the titlebar controls, for headers that clear them. */
export const BACK_TO_NOW_WIDTH = "var(--workspace-titlebar-control-size) + 0.25rem";

export function BackToNow() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Back to Now"
            className="pointer-events-auto"
            render={<Link to={TOP_LAYER_PATH} />}
          />
        }
      >
        <AssistantIcon size={18} />
      </TooltipTrigger>
      <TooltipPopup side="bottom">Back to Now</TooltipPopup>
    </Tooltip>
  );
}
