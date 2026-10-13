/**
 * One environment's section tree. Signalbox Cloud groups it by context:
 * Personal and every work organization at once, each with its own sections
 * and projects. Other environments show the plain tree.
 */
import {
  contextFoldId,
  groupSectionTreeByContext,
} from "@t3tools/client-runtime/state/signalboxContexts";
import type { SectionTreeNode } from "@t3tools/client-runtime/state/sections";
import type { EnvironmentId } from "@t3tools/contracts";
import { FolderPlusIcon } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { Button } from "../../ui/button";
import { CollapsibleSectionHeader } from "../../ui/collapsible-section-header";
import { SidebarMenu } from "../../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { DriveShareDialogHost } from "../../drives/DriveProjectShareMenuItem";
import { NewSharedDriveButton } from "../../drives/NewSharedDriveButton";
import { useSectionSidebarActions } from "../sections/SectionSidebarActions";
import {
  sectionSidebarSectionKey,
  type SectionSidebarEnvironment,
  type SectionSidebarProject,
} from "../sections/sectionProjectTree";

export function ContextSectionGroups(props: {
  environment: SectionSidebarEnvironment;
  collapsedSections: ReadonlySet<string>;
  onToggleSection: (environmentId: EnvironmentId, sectionId: string) => void;
  /** The plain tree's top-level projects, for environments without contexts. */
  rootRows: ReadonlyArray<SectionSidebarProject>;
  renderSection: (node: SectionTreeNode<SectionSidebarProject>) => ReactNode;
  renderProjects: (rows: ReadonlyArray<SectionSidebarProject>) => ReactNode;
}) {
  const { environmentId, tree, contexts } = props.environment;
  const actions = useSectionSidebarActions();
  const groups = useMemo(
    () => (contexts ? groupSectionTreeByContext(tree, contexts) : null),
    [contexts, tree],
  );
  if (!groups) {
    return (
      <SidebarMenu>
        <DriveShareDialogHost environmentId={environmentId} />
        {tree.roots.map((node) => props.renderSection(node))}
        {props.renderProjects(props.rootRows)}
      </SidebarMenu>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <DriveShareDialogHost environmentId={environmentId} />
      {groups.map(({ context, roots, projects }) => {
        const foldId = contextFoldId(context.id);
        const expanded = !props.collapsedSections.has(
          sectionSidebarSectionKey(environmentId, foldId),
        );
        return (
          <section key={context.id} aria-label={context.name} className="flex flex-col">
            <div className="flex items-center gap-1">
              <div className="min-w-0 flex-1">
                <CollapsibleSectionHeader
                  expanded={expanded}
                  onClick={() => props.onToggleSection(environmentId, foldId)}
                >
                  {context.name}
                </CollapsibleSectionHeader>
              </div>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={`New section in ${context.name}`}
                      onClick={() => actions.openCreate(environmentId, null, context.id)}
                    />
                  }
                >
                  <FolderPlusIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup side="top">New section</TooltipPopup>
              </Tooltip>
              {context.kind === "organization" ? (
                <NewSharedDriveButton
                  environmentId={environmentId}
                  contextId={context.id}
                  contextName={context.name}
                />
              ) : null}
            </div>
            {expanded ? (
              <SidebarMenu>
                {roots.map((node) => props.renderSection(node))}
                {props.renderProjects(projects)}
              </SidebarMenu>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
