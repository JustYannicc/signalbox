/**
 * The Plugins sidebar body when not searching: section rows, the Home levels,
 * and an Executor note pinned to the bottom only when something is wrong.
 */
import { ShieldIcon } from "lucide-react";

import { HomeSectionLabel } from "../sidebar/HomeSidebarTree";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { useLevelOptionsContext } from "../levels/LevelOptionsProvider";
import { LEVEL_POLICIES } from "./levelPolicyFixtures";
import { hasRestrictions } from "./levelPolicyModel";
import { EXECUTOR_STATUS, INTEGRATIONS } from "./pluginsFixtures";
import { needsAttention, PLUGINS_SECTION_LABEL, type PluginsSection } from "./pluginsModel";
import { PLUGINS_NAV, PLUGINS_SECTION_COUNTS, type PluginsTarget } from "./pluginsNav";

const ATTENTION_COUNT = INTEGRATIONS.filter(needsAttention).length;

function ExecutorNote(props: { onOpen: () => void }) {
  const disconnected = EXECUTOR_STATUS.state !== "connected";
  if (!disconnected && ATTENTION_COUNT === 0) return null;
  return (
    <button
      type="button"
      onClick={props.onOpen}
      className="mt-auto flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-medium text-sidebar-foreground outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      <span
        aria-hidden
        className={
          disconnected ? "size-1.5 rounded-full bg-error" : "size-1.5 rounded-full bg-warning"
        }
      />
      {disconnected
        ? "Executor disconnected"
        : `${ATTENTION_COUNT} ${ATTENTION_COUNT === 1 ? "connection needs" : "connections need"} attention`}
    </button>
  );
}

export function PluginsSidebarNav(props: {
  activeSection: PluginsSection | null;
  /** A level (`group`, its key) or skill detail is open, so its section row is not the current page. */
  activeDetail: { group?: string | undefined; skill?: string | undefined };
  onOpen: (target: PluginsTarget) => void;
}) {
  const { activeSection, activeDetail } = props;
  // Top level and sections; projects are one click away in Levels.
  const levels = useLevelOptionsContext().filter((option) => option.kind !== "project");
  return (
    <div className="flex flex-1 flex-col px-2 pb-2">
      <div className="pt-2">
        <SidebarMenu>
          {PLUGINS_NAV.map(({ section, icon: SectionIcon }) => {
            const count = PLUGINS_SECTION_COUNTS[section];
            return (
              <SidebarMenuItem key={section}>
                <SidebarMenuButton
                  isActive={
                    activeSection === section && !(section === "skills" && activeDetail.skill)
                  }
                  onClick={() => props.onOpen({ section })}
                >
                  <SectionIcon />
                  <span className="min-w-0 flex-1 truncate">{PLUGINS_SECTION_LABEL[section]}</span>
                  {count === null ? null : (
                    <span className="shrink-0 text-xs text-sidebar-muted-foreground/70 tabular-nums">
                      {count}
                    </span>
                  )}
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </div>
      <div className="pt-3">
        <HomeSectionLabel>Levels</HomeSectionLabel>
        <SidebarMenu>
          {levels.map((level) => (
            <SidebarMenuItem key={level.key}>
              <SidebarMenuButton
                isActive={activeSection === "levels" && activeDetail.group === level.key}
                onClick={() => props.onOpen({ section: "levels", group: level.key })}
              >
                <span className="min-w-0 flex-1 truncate">{level.label}</span>
                {hasRestrictions(LEVEL_POLICIES.find((policy) => policy.level === level.key)) ? (
                  <ShieldIcon
                    aria-label="Admin-managed"
                    className="text-sidebar-muted-foreground/70"
                  />
                ) : null}
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </div>
      <ExecutorNote onOpen={() => props.onOpen({ section: "overview" })} />
    </div>
  );
}
