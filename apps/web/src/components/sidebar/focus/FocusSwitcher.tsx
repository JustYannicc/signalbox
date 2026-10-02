/**
 * Rail control for Focus. A moon, filled while a mode hides something; the menu switches
 * it, lists the rules that switch it on their own (one line each, with the
 * direction), and marks a mode a rule set with "(auto)". Mount it inside a
 * rail `SidebarMenuItem`, like the other rail buttons.
 */
import { useNavigate } from "@tanstack/react-router";
import { MoonIcon, ZapIcon } from "lucide-react";
import { useState } from "react";

import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../../ui/menu";
import { SidebarMenuButton, useSidebar } from "../../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import {
  FOCUS_AUTOMATION_ID,
  FOCUS_MODES,
  FOCUS_RULES,
  focusModeInfo,
  useFocusMode,
  useFocusStore,
  type FocusMode,
} from "./focusStore";

function isFocusMode(value: unknown): value is FocusMode {
  return FOCUS_MODES.some((info) => info.mode === value);
}

export function FocusSwitcher() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const mode = useFocusMode();
  const setByRuleId = useFocusStore((state) => state.setByRuleId);
  const autoRule = FOCUS_RULES.find((rule) => rule.id === setByRuleId) ?? null;
  const current = focusModeInfo(mode);
  const [open, setOpen] = useState(false);
  const label = `Focus: ${current.label}${autoRule ? ` (auto · ${autoRule.label})` : ""}`;

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={<SidebarMenuButton aria-label={label} size="icon" isActive={open} />}
            />
          }
        >
          <MoonIcon className={mode === "all" ? undefined : "fill-current"} />
        </TooltipTrigger>
        <TooltipPopup side="right">{label}</TooltipPopup>
      </Tooltip>
      <MenuPopup side="right" align="start">
        <MenuGroup>
          <MenuGroupLabel>Focus</MenuGroupLabel>
          <MenuRadioGroup
            value={mode}
            onValueChange={(value) => {
              if (isFocusMode(value)) useFocusStore.getState().setMode(value);
            }}
          >
            {FOCUS_MODES.map(
              ({ mode: itemMode, label: itemLabel, description, icon: ItemIcon }) => (
                <MenuRadioItem key={itemMode} value={itemMode}>
                  <span className="flex items-center gap-2">
                    <ItemIcon className="size-4 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">
                      {itemLabel}
                      {itemMode === mode && autoRule ? (
                        <span className="text-muted-foreground"> (auto)</span>
                      ) : null}
                    </span>
                    <span className="text-xs text-muted-foreground">{description}</span>
                    <span className="flex w-3.5 justify-center">
                      <MenuRadioItemIndicator />
                    </span>
                  </span>
                </MenuRadioItem>
              ),
            )}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Auto</MenuGroupLabel>
          {FOCUS_RULES.map((rule) => (
            <div
              key={rule.id}
              className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground"
            >
              <ZapIcon className="size-3 shrink-0" />
              <span>{rule.label}</span>
            </div>
          ))}
        </MenuGroup>
        <MenuItem
          onClick={() => {
            if (isMobile) setOpenMobile(false);
            void navigate({
              to: "/automations/$automationId",
              params: { automationId: FOCUS_AUTOMATION_ID },
            });
          }}
        >
          Edit focus rules…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
