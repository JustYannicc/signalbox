/**
 * The always-visible icon column of the thread sidebar. The top group switches
 * the panel beside it (automations, places and pull requests live in Home
 * folders); the bottom group holds Usage, feedback, Focus, and Settings.
 * Computers, devices, and team live under Settings. Pipeline carries a count
 * while anything in sight waits on the user, so it can announce itself
 * without being the open view; Usage carries a red dot while an account needs
 * attention.
 */
import { useLocation, useNavigate } from "@tanstack/react-router";
import { BellIcon, BlocksIcon, HouseIcon, SettingsIcon, type LucideIcon } from "lucide-react";
import { memo, type ReactNode } from "react";

import { Badge } from "../ui/badge";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { UsageNavIcon } from "../usage/UsageNavIcon";
import { SidebarFeedbackButton } from "./feedback/SidebarFeedbackButton";
import { FocusSwitcher } from "./focus/FocusSwitcher";
import type { SidebarView } from "./sidebarView";
import { useNeedsYouCount } from "./sections/useNeedsYouCount";

const VIEW_ITEMS: ReadonlyArray<{ view: SidebarView; label: string; icon: LucideIcon }> = [
  { view: "home", label: "Home", icon: HouseIcon },
  { view: "pipeline", label: "Pipeline", icon: BellIcon },
  { view: "plugins", label: "Plugins", icon: BlocksIcon },
];

function RailButton(props: {
  label: string;
  active: boolean;
  onClick: () => void;
  /** Things waiting on the user behind this entry; shown as a count on the icon. */
  badge?: number;
  children: ReactNode;
}) {
  const badge = props.badge ?? 0;
  return (
    <SidebarMenuItem>
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label={badge > 0 ? `${props.label}, ${badge} waiting on you` : props.label}
              aria-current={props.active ? "page" : undefined}
              isActive={props.active}
              size="icon"
              onClick={props.onClick}
            />
          }
        >
          {props.children}
          {badge > 0 ? (
            <Badge aria-hidden size="sm" className="absolute -top-0.5 -right-0.5">
              {badge > 9 ? "9+" : badge}
            </Badge>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="right">
          {badge > 0 ? `${props.label} · ${badge} waiting on you` : props.label}
        </TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

// Pages opened from the bottom group; each lights up while any of its paths is
// open. Computers, devices, and team moved into Settings, so they light it too.
const USAGE_PAGE = {
  to: "/costs",
  label: "Usage",
  paths: ["/costs", "/accounts", "/usage"],
} as const;
const SETTINGS_PAGE = {
  to: "/settings",
  label: "Settings",
  paths: ["/settings", "/devices", "/team", "/computers", "/setup", "/capture"],
} as const;

function isPathOpen(pathname: string, paths: ReadonlyArray<string>): boolean {
  return paths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export const SidebarViewRail = memo(function SidebarViewRail(props: {
  /** Null while a page outside the views (settings, usage…) is open. */
  view: SidebarView | null;
  onViewChange: (view: SidebarView) => void;
}) {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { isMobile, setOpenMobile } = useSidebar();
  // One count for the rail, Home and Pipeline; respects Focus.
  const needsYou = useNeedsYouCount();
  const leaveSidebar = () => {
    if (isMobile) setOpenMobile(false);
  };

  const renderPage = (page: typeof USAGE_PAGE | typeof SETTINGS_PAGE, icon: ReactNode) => (
    <RailButton
      label={page.label}
      active={isPathOpen(pathname, page.paths)}
      onClick={() => {
        leaveSidebar();
        void navigate({ to: page.to });
      }}
    >
      {icon}
    </RailButton>
  );

  return (
    <nav
      aria-label="Sidebar views"
      className="flex min-h-0 w-12 flex-1 flex-col items-center justify-between gap-4 overflow-y-auto pt-1 pb-2 [scrollbar-width:none]"
    >
      <SidebarMenu className="items-center">
        {VIEW_ITEMS.map(({ view, label, icon: Icon }) => (
          <RailButton
            key={view}
            label={label}
            active={props.view === view}
            {...(view === "pipeline" ? { badge: needsYou } : {})}
            onClick={() => props.onViewChange(view)}
          >
            <Icon />
          </RailButton>
        ))}
      </SidebarMenu>
      <SidebarMenu className="items-center">
        {renderPage(USAGE_PAGE, <UsageNavIcon />)}
        <SidebarMenuItem>
          <SidebarFeedbackButton />
        </SidebarMenuItem>
        <SidebarMenuItem>
          <FocusSwitcher />
        </SidebarMenuItem>
        {renderPage(SETTINGS_PAGE, <SettingsIcon />)}
      </SidebarMenu>
    </nav>
  );
});
