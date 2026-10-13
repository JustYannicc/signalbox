/**
 * Rail control for Focus. A moon, filled while Focus hides something; the menu
 * picks the level in sight (All, or a root section), lists the rules that
 * switch it on their own (one line each, with the direction), and marks a
 * level a rule set with "(auto)". Mount it inside a rail `SidebarMenuItem`,
 * like the other rail buttons.
 */
import { useNavigate } from "@tanstack/react-router";
import {
  BriefcaseIcon,
  CoffeeIcon,
  FolderIcon,
  LayersIcon,
  MoonIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

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
import { TOP_LEVEL, type LevelKey } from "../../levels/levels";
import { allHomeSections } from "../sections/sectionModel";
import { useHomeSectionStore } from "../sections/sectionStore";
import { focusLabel } from "./focusLevels";
import { FOCUS_AUTOMATION_ID, FOCUS_RULES, useFocusedLevel, useFocusStore } from "./focusStore";

interface FocusOption {
  readonly level: LevelKey;
  readonly label: string;
  readonly description: string;
  readonly icon: LucideIcon;
}

const SECTION_ICONS: Readonly<Record<string, LucideIcon>> = {
  work: BriefcaseIcon,
  personal: CoffeeIcon,
};

/** All, then each root section; picking one hides the others. */
function useFocusOptions(): readonly FocusOption[] {
  // Cached by `allHomeSections`, so this only changes when sections do.
  const sections = useHomeSectionStore(() => allHomeSections());
  return useMemo(() => {
    const roots = sections.filter((section) => section.parentId === null);
    return [
      { level: TOP_LEVEL, label: "All", description: "Everything in sight", icon: LayersIcon },
      ...roots.map((section) => {
        const others = roots.filter((other) => other.id !== section.id);
        return {
          level: `section:${section.id}`,
          label: section.name,
          description: others.length === 1 ? `Hides ${others[0]?.name}` : "Hides everything else",
          icon: SECTION_ICONS[section.id] ?? FolderIcon,
        };
      }),
    ];
  }, [sections]);
}

export function FocusSwitcher() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const focused = useFocusedLevel();
  const options = useFocusOptions();
  const setByRuleId = useFocusStore((state) => state.setByRuleId);
  const autoRule = FOCUS_RULES.find((rule) => rule.id === setByRuleId) ?? null;
  const [open, setOpen] = useState(false);
  const label = `Focus: ${focusLabel(focused)}${autoRule ? ` (auto · ${autoRule.label})` : ""}`;

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
          <MoonIcon className={focused === TOP_LEVEL ? undefined : "fill-current"} />
        </TooltipTrigger>
        <TooltipPopup side="right">{label}</TooltipPopup>
      </Tooltip>
      <MenuPopup side="right" align="start">
        <MenuGroup>
          <MenuGroupLabel>Focus</MenuGroupLabel>
          <MenuRadioGroup
            value={focused}
            onValueChange={(value) => {
              const option = options.find((candidate) => candidate.level === value);
              if (option) useFocusStore.getState().focusLevel(option.level);
            }}
          >
            {options.map(({ level: itemLevel, label: itemLabel, description, icon: ItemIcon }) => (
              <MenuRadioItem key={itemLevel} value={itemLevel}>
                <span className="flex items-center gap-2">
                  <ItemIcon className="size-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">
                    {itemLabel}
                    {itemLevel === focused && autoRule ? (
                      <span className="text-muted-foreground"> (auto)</span>
                    ) : null}
                  </span>
                  <span className="text-xs text-muted-foreground">{description}</span>
                  <span className="flex w-3.5 justify-center">
                    <MenuRadioItemIndicator />
                  </span>
                </span>
              </MenuRadioItem>
            ))}
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
              to: "/home/automations/$automationId",
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
