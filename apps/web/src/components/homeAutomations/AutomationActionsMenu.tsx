/**
 * The automation header's overflow menu. Changes go through the agent of
 * the level the automation lives in. System automations can't be removed; they offer Reset to default
 * instead, with the reason shown under the disabled Remove.
 */
import { CopyIcon, EllipsisIcon, MessageCircleIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";

import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import type { Automation } from "./automationModel";
import { notifyAutomationsComingSoon } from "./comingSoon";
import { useOpenAutomationAgent } from "./AutomationAgent";

export function AutomationActionsMenu(props: { automation: Automation }) {
  const { automation } = props;
  const openAgent = useOpenAutomationAgent();
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button variant="ghost-muted" size="icon-xs" aria-label="More automation actions">
            <EllipsisIcon />
          </Button>
        }
      />
      <MenuPopup side="bottom" align="end">
        <MenuItem onClick={() => openAgent(`Change the “${automation.name}” automation: `)}>
          <MessageCircleIcon />
          Change with agent
        </MenuItem>
        <MenuItem onClick={() => notifyAutomationsComingSoon("Duplicating")}>
          <CopyIcon />
          Duplicate
        </MenuItem>
        <MenuSeparator />
        {automation.system ? (
          <>
            <MenuItem onClick={() => notifyAutomationsComingSoon("Reset to default")}>
              <RotateCcwIcon />
              Reset to default
            </MenuItem>
            <MenuItem variant="destructive" disabled>
              <Trash2Icon />
              Remove automation
            </MenuItem>
            <p className="max-w-64 px-2 pt-0.5 pb-1.5 text-xs leading-relaxed text-pretty text-muted-foreground">
              {automation.system.reason}
            </p>
          </>
        ) : (
          <MenuItem
            variant="destructive"
            onClick={() => notifyAutomationsComingSoon("Removing automations")}
          >
            <Trash2Icon />
            Remove automation
          </MenuItem>
        )}
      </MenuPopup>
    </Menu>
  );
}
