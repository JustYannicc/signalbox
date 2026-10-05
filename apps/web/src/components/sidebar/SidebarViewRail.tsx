/**
 * The always-visible icon column of the sidebar. The top group switches the
 * panel beside it; the bottom group opens Usage and Settings.
 * Entries that don't run on real data yet stay visible but disabled, with a
 * "coming soon" tooltip.
 */
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  BellIcon,
  BlocksIcon,
  ChartNoAxesColumnIcon,
  HouseIcon,
  LibraryIcon,
  MessageSquareHeartIcon,
  MoonIcon,
  SettingsIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, type ReactNode } from "react";

import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { SidebarView } from "./sidebarView";

type RailEntry =
  | { kind: "view"; view: SidebarView; label: string; icon: LucideIcon }
  | { kind: "soon"; label: string; icon: LucideIcon };

const VIEW_ENTRIES: ReadonlyArray<RailEntry> = [
  { kind: "view", view: "home", label: "Home", icon: HouseIcon },
  { kind: "soon", label: "Spaces", icon: LibraryIcon },
  { kind: "soon", label: "Automations", icon: WorkflowIcon },
  { kind: "view", view: "pipeline", label: "Pipeline", icon: BellIcon },
  { kind: "soon", label: "Plugins", icon: BlocksIcon },
];

function RailButton(props: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
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
    </SidebarMenuItem>
  );
}

// Disabled buttons drop pointer events, so the tooltip hangs off a wrapper.
function ComingSoonButton(props: { label: string; children: ReactNode }) {
  return (
    <SidebarMenuItem>
      <Tooltip>
        <TooltipTrigger render={<span className="flex" />}>
          <SidebarMenuButton aria-label={`${props.label} (coming soon)`} disabled size="icon">
            {props.children}
          </SidebarMenuButton>
        </TooltipTrigger>
        <TooltipPopup side="right">{props.label} · Coming soon</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

function isPathOpen(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`);
}

export const SidebarViewRail = memo(function SidebarViewRail(props: {
  /** Null while a page outside the views (settings, usage…) is open. */
  view: SidebarView | null;
  onViewChange: (view: SidebarView) => void;
}) {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { isMobile, setOpenMobile } = useSidebar();
  const leaveSidebar = () => {
    if (isMobile) setOpenMobile(false);
  };

  return (
    <nav
      aria-label="Sidebar views"
      className="flex min-h-0 w-12 flex-1 flex-col items-center justify-between gap-4 overflow-y-auto pt-1 pb-2 [scrollbar-width:none]"
    >
      <SidebarMenu className="items-center">
        {VIEW_ENTRIES.map((entry) =>
          entry.kind === "view" ? (
            <RailButton
              key={entry.label}
              label={entry.label}
              active={props.view === entry.view}
              onClick={() => props.onViewChange(entry.view)}
            >
              <entry.icon />
            </RailButton>
          ) : (
            <ComingSoonButton key={entry.label} label={entry.label}>
              <entry.icon />
            </ComingSoonButton>
          ),
        )}
      </SidebarMenu>
      <SidebarMenu className="items-center">
        <RailButton
          label="Usage"
          active={isPathOpen(pathname, "/usage")}
          onClick={() => {
            leaveSidebar();
            void navigate({ to: "/usage" });
          }}
        >
          <ChartNoAxesColumnIcon />
        </RailButton>
        <ComingSoonButton label="Feedback">
          <MessageSquareHeartIcon />
        </ComingSoonButton>
        <ComingSoonButton label="Focus">
          <MoonIcon />
        </ComingSoonButton>
        <RailButton
          label="Settings"
          active={isPathOpen(pathname, "/settings")}
          onClick={() => {
            leaveSidebar();
            void navigate({ to: "/settings" });
          }}
        >
          <SettingsIcon />
        </RailButton>
      </SidebarMenu>
    </nav>
  );
});
