/**
 * Plugins: one place for everything agents can use across harnesses.
 * UI prototype on placeholder data (see pluginsFixtures.ts).
 */
import { Link, useNavigate } from "@tanstack/react-router";
import { DownloadIcon, PlusIcon } from "lucide-react";

import { isElectron } from "../../env";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { groupById } from "./groupPrimitives";
import { GroupsSection } from "./GroupsSection";
import { HarnessPluginsSection } from "./HarnessPluginsSection";
import { InstructionsSection } from "./InstructionsSection";
import { IntegrationList } from "./IntegrationList";
import { MarketplaceSection } from "./MarketplaceSection";
import { PluginsOverview } from "./PluginsOverview";
import { SKILLS } from "./pluginsFixtures";
import { PLUGINS_SECTION_LABEL } from "./pluginsModel";
import { comingSoon } from "./pluginsPrimitives";
import type { PluginsSearch } from "./pluginsSearch";
import { SkillsSection } from "./SkillsSection";

function PluginsSectionContent(props: { search: PluginsSearch }) {
  const { search } = props;
  const navigate = useNavigate();
  switch (search.section ?? "overview") {
    case "overview":
      return <PluginsOverview />;
    case "marketplace":
      return <MarketplaceSection key={search.item} kind={search.kind} item={search.item} />;
    case "groups":
      return <GroupsSection groupId={search.group} tab={search.tab} item={search.item} />;
    case "connections":
      // Keyed so a deep link to another row re-expands it.
      return <IntegrationList key={search.item} item={search.item} />;
    case "harness-plugins":
      return <HarnessPluginsSection item={search.item} />;
    case "skills":
      return <SkillsSection skillId={search.skill} />;
    case "instructions":
      return (
        <InstructionsSection
          role={search.role ?? "thread"}
          scope={search.scope ?? "personal"}
          onNavigate={(next) =>
            void navigate({
              to: "/plugins",
              search: { section: "instructions", ...next },
              replace: true,
            })
          }
        />
      );
  }
}

/** One page action per section, where there is one. Add connection lives in the sidebar. */
function SectionAction(props: { search: PluginsSearch }) {
  if (props.search.section === "skills" && !props.search.skill) {
    return (
      <Button
        size="sm"
        variant="outline"
        render={<Link to="/plugins" search={{ section: "marketplace", kind: "skills" }} />}
      >
        <DownloadIcon aria-hidden />
        Install
      </Button>
    );
  }
  if (props.search.section === "groups" && !props.search.group) {
    return (
      <Button size="sm" variant="outline" onClick={() => comingSoon("New group")}>
        <PlusIcon aria-hidden />
        New group
      </Button>
    );
  }
  return null;
}

export function PluginsPage(props: { search: PluginsSearch }) {
  const { search } = props;
  const section = search.section ?? "overview";
  const detailName = search.group
    ? groupById(search.group)?.name
    : search.skill
      ? SKILLS.find((skill) => skill.id === search.skill)?.name
      : undefined;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          <div className="flex w-full min-w-0 items-center gap-3 py-2">
            <WorkspaceBreadcrumb ariaLabel="Plugins breadcrumb" className="min-w-0 flex-1">
              <WorkspaceBreadcrumbItem current={section === "overview"}>
                <h1>Plugins</h1>
              </WorkspaceBreadcrumbItem>
              {section === "overview" ? null : (
                <>
                  <WorkspaceBreadcrumbSeparator />
                  <WorkspaceBreadcrumbItem current={!detailName}>
                    {PLUGINS_SECTION_LABEL[section]}
                  </WorkspaceBreadcrumbItem>
                  {detailName ? (
                    <>
                      <WorkspaceBreadcrumbSeparator />
                      <WorkspaceBreadcrumbItem current>{detailName}</WorkspaceBreadcrumbItem>
                    </>
                  ) : null}
                </>
              )}
            </WorkspaceBreadcrumb>
            <SectionAction search={search} />
          </div>
        </WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            <PluginsSectionContent search={search} />
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
