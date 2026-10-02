/**
 * The always-visible icon column of the thread sidebar. The top group switches
 * the panel beside it (Pull Requests lives in Spaces); the bottom group holds
 * Usage, feedback, Focus, and Settings. Computers, devices, and team live
 * under Settings. The bell carries a dot while any thread waits on
 * the user, so Pipeline can announce itself without being the open view.
 */
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  BellIcon,
  BlocksIcon,
  ChartNoAxesColumnIcon,
  HouseIcon,
  LibraryIcon,
  SettingsIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, type ReactNode } from "react";

import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarFeedbackButton } from "./feedback/SidebarFeedbackButton";
import { FocusSwitcher } from "./focus/FocusSwitcher";
import type { SidebarView } from "./sidebarView";
import { useNeedsYouCount } from "./sections/useNeedsYouCount";

const VIEW_ITEMS: ReadonlyArray<{ view: SidebarView; label: string; icon: LucideIcon }> = [
  { view: "home", label: "Home", icon: HouseIcon },
  { view: "spaces", label: "Spaces", icon: LibraryIcon },
  { view: "automations", label: "Automations", icon: WorkflowIcon },
  { view: "pipeline", label: "Pipeline", icon: BellIcon },
  { view: "plugins", label: "Plugins", icon: BlocksIcon },
];

function RailButton(props: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  badge?: boolean;
}) {
  return (
    <SidebarMenuItem>
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label={props.label}
              aria-current={props.active ? "page" : undefined}
              isActive={props.active}
              size="icon"
              onClick={props.onClick}
            />
          }
        >
          {props.children}
        </TooltipTrigger>
        <TooltipPopup side="right">{props.label}</TooltipPopup>
      </Tooltip>
      {props.badge ? (
        <span
          aria-hidden
          className="pointer-events-none absolute top-1 right-1 size-2 rounded-full bg-primary ring-2 ring-sidebar"
        />
      ) : null}
    </SidebarMenuItem>
  );
}

// Pages opened from the bottom group; each lights up while any of its paths is
// open. Computers, devices, and team moved into Settings, so they light it too.
const USAGE_PAGE = {
  to: "/accounts",
  label: "Usage",
  icon: ChartNoAxesColumnIcon,
  paths: ["/accounts", "/usage"],
} as const;
const SETTINGS_PAGE = {
  to: "/settings",
  label: "Settings",
  icon: SettingsIcon,
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
  // One count for the bell, Home and Pipeline; respects Focus.
  const pipelineNeedsAttention = useNeedsYouCount() > 0;
  const leaveSidebar = () => {
    if (isMobile) setOpenMobile(false);
  };

  const renderView = ({ view, label, icon: Icon }: (typeof VIEW_ITEMS)[number]) => (
    <RailButton
      key={view}
      label={label}
      active={props.view === view}
      badge={view === "pipeline" && pipelineNeedsAttention}
      onClick={() => props.onViewChange(view)}
    >
      <Icon />
    </RailButton>
  );
  const renderPage = ({
    to,
    label,
    icon: Icon,
    paths,
  }: typeof USAGE_PAGE | typeof SETTINGS_PAGE) => (
    <RailButton
      label={label}
      active={isPathOpen(pathname, paths)}
      onClick={() => {
        leaveSidebar();
        void navigate({ to });
      }}
    >
      <Icon />
    </RailButton>
  );

  return (
    <nav
      aria-label="Sidebar views"
      className="flex min-h-0 w-12 flex-1 flex-col items-center justify-between gap-4 overflow-y-auto pt-1 pb-2 [scrollbar-width:none]"
    >
      <SidebarMenu className="items-center">{VIEW_ITEMS.map(renderView)}</SidebarMenu>
      <SidebarMenu className="items-center">
        {renderPage(USAGE_PAGE)}
        <SidebarMenuItem>
          <SidebarFeedbackButton />
        </SidebarMenuItem>
        <SidebarMenuItem>
          <FocusSwitcher />
        </SidebarMenuItem>
        {renderPage(SETTINGS_PAGE)}
      </SidebarMenu>
    </nav>
  );
});
