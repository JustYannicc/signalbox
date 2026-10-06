import type { SectionTreeNode } from "@t3tools/client-runtime/state/sections";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { ChevronRightIcon, FolderClosedIcon } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { SidebarMenu, SidebarMenuItem } from "../../ui/sidebar";
import {
  sectionSidebarSectionKey,
  type SectionSidebarEnvironment,
  type SectionSidebarProject,
} from "./sectionProjectTree";
import { ProjectPlacementMenu, SectionMoveMenu } from "./SectionPlacementMenus";

type RenderProject = (
  environmentId: EnvironmentId,
  project: SectionSidebarProject,
  sectionId: string | null,
  siblingProjectIds: ReadonlyArray<ProjectId>,
  actions: ReactNode,
) => ReactNode;

function ProjectRows(props: {
  environment: SectionSidebarEnvironment;
  rows: ReadonlyArray<SectionSidebarProject>;
  sectionId: string | null;
  renderProject: RenderProject;
}) {
  const siblingIds = useMemo(() => props.rows.map((row) => row.id), [props.rows]);
  return props.rows.map((project) =>
    props.renderProject(
      props.environment.environmentId,
      project,
      props.sectionId,
      siblingIds,
      <ProjectPlacementMenu
        environment={props.environment}
        project={project}
        sectionId={props.sectionId}
        siblingProjectIds={siblingIds}
      />,
    ),
  );
}

function SectionNode(props: {
  environment: SectionSidebarEnvironment;
  node: SectionTreeNode<SectionSidebarProject>;
  collapsedSections: ReadonlySet<string>;
  onToggleSection: (environmentId: EnvironmentId, sectionId: string) => void;
  renderProject: RenderProject;
}) {
  const sectionKey = sectionSidebarSectionKey(
    props.environment.environmentId,
    props.node.section.id,
  );
  const expanded = !props.collapsedSections.has(sectionKey);
  const snapshot = props.environment.snapshot;
  const section = props.node.section;
  const siblings = snapshot?.sections.filter((item) => item.parentId === section.parentId) ?? [];

  return (
    <SidebarMenuItem>
      <div className="group/section-row flex h-8 items-center gap-1 rounded-md px-1 hover:bg-sidebar-row-hover">
        <button
          type="button"
          aria-label={`${expanded ? "Collapse" : "Expand"} ${section.name}`}
          aria-expanded={expanded}
          onClick={() =>
            props.onToggleSection(props.environment.environmentId, props.node.section.id)
          }
          className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-sidebar-muted-foreground/60 hover:text-sidebar-foreground"
        >
          <ChevronRightIcon
            className={`size-3 transition-transform ${expanded ? "rotate-90" : ""}`}
          />
        </button>
        <FolderClosedIcon className="size-3.5 shrink-0 text-icon-muted" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-muted-foreground/85">
          {section.name}
        </span>
        {snapshot ? (
          <SectionMoveMenu
            environmentId={props.environment.environmentId}
            snapshot={snapshot}
            section={section}
            siblings={siblings}
          />
        ) : null}
      </div>
      {expanded ? (
        <ul className="ml-3 flex flex-col gap-px border-l border-sidebar-border pl-2">
          {props.node.childSections.map((child) => (
            <SectionNode
              key={`${props.environment.environmentId}:${child.section.id}`}
              environment={props.environment}
              node={child}
              collapsedSections={props.collapsedSections}
              onToggleSection={props.onToggleSection}
              renderProject={props.renderProject}
            />
          ))}
          <ProjectRows
            environment={props.environment}
            rows={props.node.projects}
            sectionId={section.id}
            renderProject={props.renderProject}
          />
          {props.node.childSections.length === 0 && props.node.projects.length === 0 ? (
            <li className="flex h-7 items-center px-2 text-xs text-sidebar-muted-foreground/55">
              Empty section
            </li>
          ) : null}
        </ul>
      ) : null}
    </SidebarMenuItem>
  );
}

export function SectionsProjectTree(props: {
  environments: ReadonlyArray<SectionSidebarEnvironment>;
  showEnvironmentLabels: boolean;
  collapsedSections: ReadonlySet<string>;
  onToggleSection: (environmentId: EnvironmentId, sectionId: string) => void;
  renderProject: RenderProject;
}) {
  return (
    <div className="flex flex-col gap-2">
      {props.environments.map((environment) => {
        const rootRows = [...environment.tree.rootProjects, ...environment.tree.unplacedProjects];
        if (rootRows.length === 0 && environment.tree.roots.length === 0) return null;
        return (
          <section key={environment.environmentId} aria-label={environment.label}>
            {props.showEnvironmentLabels ? (
              <h3 className="px-2.5 pb-1 text-xs font-medium text-sidebar-muted-foreground/70">
                {environment.label}
              </h3>
            ) : null}
            <SidebarMenu>
              {environment.tree.roots.map((node) => (
                <SectionNode
                  key={`${environment.environmentId}:${node.section.id}`}
                  environment={environment}
                  node={node}
                  collapsedSections={props.collapsedSections}
                  onToggleSection={props.onToggleSection}
                  renderProject={props.renderProject}
                />
              ))}
              <ProjectRows
                environment={environment}
                rows={rootRows}
                sectionId={null}
                renderProject={props.renderProject}
              />
            </SidebarMenu>
          </section>
        );
      })}
    </div>
  );
}
