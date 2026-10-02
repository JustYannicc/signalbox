/**
 * Plugins: the sidebar panel for everything agents can use. Rows route to
 * /plugins sections; search jumps straight to a group, account, plugin, or skill.
 * Prototype on placeholder data from components/plugins/pluginsFixtures.ts.
 */
import { useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { PlusIcon, SearchIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { AddConnectionDialog } from "../plugins/AddConnectionDialog";
import { decodePluginsSection, PLUGINS_SECTION_LABEL } from "../plugins/pluginsModel";
import { PLUGINS_SEARCH_ENTRIES, pluginsSearch, type PluginsTarget } from "../plugins/pluginsNav";
import { PluginsSidebarNav } from "../plugins/PluginsSidebarNav";
import {
  SidebarContent,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";
import { HomeSectionLabel } from "./HomeSidebarTree";
import { SidebarChromeFooter } from "./SidebarChrome";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";

export function PluginsSidebar() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const onPluginsPage = useLocation({ select: (location) => location.pathname === "/plugins" });
  const rawSection = useSearch({ strict: false, select: (search) => search.section });
  const activeSection = onPluginsPage
    ? Option.getOrElse(decodePluginsSection(rawSection), () => "overview" as const)
    : null;

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const query = searchQuery.trim().toLowerCase();
  const searchResults = useMemo(
    () =>
      query
        ? PLUGINS_SEARCH_ENTRIES.filter((entry) => entry.label.toLowerCase().includes(query))
        : [],
    [query],
  );

  const activeGroup = useSearch({ strict: false, select: (search) => search.group });
  const activeSkill = useSearch({ strict: false, select: (search) => search.skill });
  const open = (target: PluginsTarget) => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/plugins", search: pluginsSearch(target) });
  };
  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery("");
  };

  return (
    <>
      <SidebarContent
        fixedHeader={
          <div className="flex flex-col gap-2 p-2 pb-1">
            <div className="flex h-8 items-center gap-1 pl-2.5">
              {searchOpen ? (
                <>
                  <SearchIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
                  <SidebarInput
                    nativeInput
                    autoFocus
                    type="search"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        closeSearch();
                      }
                    }}
                    placeholder="Search plugins"
                    aria-label="Search plugins"
                    className="min-w-0 flex-1"
                  />
                  <SidebarHeaderIconButton label="Close search" onClick={closeSearch}>
                    <XIcon />
                  </SidebarHeaderIconButton>
                </>
              ) : (
                <>
                  <h2 className="min-w-0 flex-1 truncate text-base font-semibold tracking-tight text-sidebar-foreground">
                    Plugins
                  </h2>
                  <SidebarHeaderIconButton
                    label="Search plugins"
                    onClick={() => setSearchOpen(true)}
                  >
                    <SearchIcon />
                  </SidebarHeaderIconButton>
                </>
              )}
            </div>
            <SidebarMenu>
              <SidebarMenuItem>
                <AddConnectionDialog trigger={<SidebarMenuButton />}>
                  <PlusIcon />
                  <span className="min-w-0 flex-1 truncate text-sidebar-foreground">
                    Add connection
                  </span>
                </AddConnectionDialog>
              </SidebarMenuItem>
            </SidebarMenu>
          </div>
        }
      >
        {query ? (
          <div className="flex flex-col px-2 pb-2">
            <HomeSectionLabel>
              {searchResults.length > 0 ? "Results" : "Nothing found"}
            </HomeSectionLabel>
            <SidebarMenu>
              {searchResults.map((entry) => (
                <SidebarMenuItem key={entry.key}>
                  <SidebarMenuButton
                    onClick={() => {
                      closeSearch();
                      open(entry.target);
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                    <span className="shrink-0 text-xs text-sidebar-muted-foreground/60">
                      {PLUGINS_SECTION_LABEL[entry.target.section]}
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </div>
        ) : (
          <PluginsSidebarNav
            activeSection={activeSection}
            activeDetail={{ group: activeGroup, skill: activeSkill }}
            onOpen={open}
          />
        )}
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}
