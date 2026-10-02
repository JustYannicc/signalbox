import { ArrowLeftIcon, ChartNoAxesColumnIcon, SettingsIcon } from "lucide-react";
import type { ReactNode } from "react";
import { createContext, memo, use, useCallback } from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";

import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useEnvironments } from "../../state/environments";
import { SignalboxLogo } from "../SignalboxMark";
import { useAssistantIdentity } from "../assistant/assistantIdentity";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  SidebarStageBackdrop,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { isSidebarUtilityPage, useNavigateToMainApp } from "./mainAppLocation";
import { SidebarThreadUndoNotice } from "./SidebarThreadUndoNotice";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";

/** True inside the view-rail layout, where the rail carries the utility buttons
 * and the titlebar row starts after the rail. */
export const SidebarRailContext = createContext(false);

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
  showBrand = true,
}: {
  isElectron: boolean;
  /** Off when the panel below names itself. */
  showBrand?: boolean;
}) {
  const railLayout = use(SidebarRailContext);
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    environmentIdentificationMode === "artwork",
  );
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;
  const onBackdrop = backdropVariant !== null;
  const trigger = (
    <SidebarTrigger
      // Over the stage artwork: the media viewer's control-on-imagery treatment.
      variant={onBackdrop ? "media-navigation" : "ghost"}
      className="relative top-auto z-10 translate-y-0 md:hidden"
    />
  );
  const pill = pillLabel ? (
    <Badge
      className="relative z-10 ml-1 hidden @[15rem]/sidebar-header:inline-flex"
      data-environment-identification="pill"
      size="sm"
      variant="secondary"
    >
      {pillLabel}
    </Badge>
  ) : null;

  if (railLayout) {
    // The rail layout: this row sits beside the rail, so the brand clears the
    // fixed back/forward/toggle cluster minus the rail's width. The rail layout
    // paints the stage backdrop across rail and panel itself.
    return (
      <div
        className={cn(
          "@container/sidebar-header relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 px-3 md:px-0",
          isElectron && "drag-region",
        )}
      >
        {trigger}
        {showBrand ? <SidebarBrand onBackdrop={onBackdrop} placement="rail" /> : null}
        {pill}
      </div>
    );
  }

  return (
    // The titlebar row, not a padded SidebarHeader: it aligns to the window controls.
    <div
      className={cn(
        "@container/sidebar-header relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 px-3 md:px-0",
        isElectron && "drag-region",
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      {trigger}
      {showBrand ? <SidebarBrand onBackdrop={onBackdrop} placement="titlebar" /> : null}
      {pill}
    </div>
  );
});

function SidebarBrand({
  onBackdrop,
  placement,
}: {
  onBackdrop: boolean;
  /** Both sit after the fixed controls; "rail" starts a rail's width further right. */
  placement: "titlebar" | "rail";
}) {
  const assistant = useAssistantIdentity();
  return (
    <Link
      aria-label={`Go to ${assistant.name}`}
      className={cn(
        "relative z-10 flex w-fit min-w-0 shrink-0 items-center overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2",
        placement === "titlebar"
          ? "ml-[var(--workspace-titlebar-content-left)] h-7 max-md:hidden"
          : "h-7 md:ml-[calc(var(--workspace-titlebar-content-left)-3rem)]",
        onBackdrop ? "text-white" : "text-foreground",
      )}
      to="/assistant"
    >
      <SignalboxLogo className={placement === "titlebar" ? "text-sm" : "text-base"} />
    </Link>
  );
}

function SidebarUtilityItem({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton aria-label={label} onClick={onClick} size="icon">
              {icon}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

export const SidebarUtilityMenu = memo(function SidebarUtilityMenu() {
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const { isMobile, setOpenMobile } = useSidebar();
  const isOnUtilityPage = useLocation({
    select: (location) => isSidebarUtilityPage(location.pathname),
  });
  const { environments } = useEnvironments();
  // The page reads every connected server, so one of them offering pull requests is enough for
  // the link to lead somewhere.
  const pullRequestsSupported = environments.some(
    (environment) => environment.serverConfig?.environment.capabilities.pullRequests === true,
  );
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile, setOpenMobile]);
  const handlePullRequestsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({
      to: "/pull-requests",
      search: readPullRequestListPreferences(),
    });
  }, [closeMobileSidebar, navigate]);
  const handleSettingsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/settings" });
  }, [closeMobileSidebar, navigate]);

  const handleUsageClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/usage" });
  }, [isMobile, navigate, setOpenMobile]);

  const handleBackClick = useCallback(() => {
    closeMobileSidebar();
    void navigateToMainApp();
  }, [closeMobileSidebar, navigateToMainApp]);

  return (
    <SidebarMenu className="flex-row items-center">
      {isOnUtilityPage ? (
        <SidebarMenuItem className="min-w-0 flex-1">
          <SidebarMenuButton onClick={handleBackClick}>
            <ArrowLeftIcon />
            <span>Back</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : (
        <>
          <SidebarUtilityItem
            icon={<SettingsIcon />}
            label="Settings"
            onClick={handleSettingsClick}
          />
          {pullRequestsSupported ? (
            <SidebarUtilityItem
              icon={<PullRequestGlyph.pullRequest />}
              label="Pull Requests"
              onClick={handlePullRequestsClick}
            />
          ) : null}
          <SidebarUtilityItem
            icon={<ChartNoAxesColumnIcon />}
            label="Usage"
            onClick={handleUsageClick}
          />
        </>
      )}
      <SidebarUpdatePill />
    </SidebarMenu>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  const railOwnsUtilities = use(SidebarRailContext);
  return (
    <SidebarFooter>
      <SidebarThreadUndoNotice />
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      {railOwnsUtilities ? (
        <SidebarMenu className="flex-row items-center empty:hidden">
          <SidebarUpdatePill />
        </SidebarMenu>
      ) : (
        <SidebarUtilityMenu />
      )}
    </SidebarFooter>
  );
});
