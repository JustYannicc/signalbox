/**
 * Breadcrumb segments for an item's container. Each section or project name
 * opens your agent for it, the same as clicking it in Home.
 */
import { useNavigate } from "@tanstack/react-router";
import { Fragment } from "react";

import { findHomeSection, projectAgentId, sectionAgentId } from "../sidebar/sections/sectionModel";
import {
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { containerSectionId } from "./containerScope";
import { findTeamProject } from "./teamThreads";

interface Crumb {
  readonly key: string;
  readonly label: string;
  readonly agentId: string | null;
}

function crumbsFor(containerIdOrKey: string): readonly Crumb[] {
  const containerId = containerIdOrKey.replace(/^(section|team-project):/, "");
  const project = findTeamProject(containerId);
  const sectionId = containerSectionId(containerId);
  const section = sectionId ? findHomeSection(sectionId) : undefined;
  if (!section) return [{ key: "home", label: "Home", agentId: null }];
  const parent = section.parentId && !project ? findHomeSection(section.parentId) : undefined;
  return [
    ...(parent ? [{ key: parent.id, label: parent.name, agentId: sectionAgentId(parent.id) }] : []),
    { key: section.id, label: section.name, agentId: sectionAgentId(section.id) },
    ...(project
      ? [{ key: project.id, label: project.name, agentId: projectAgentId(project.name) }]
      : []),
  ];
}

/** Renders `Section › Project ›`, ending with a separator before the item title. */
export function ContainerCrumbs(props: { containerId: string }) {
  const navigate = useNavigate();
  const crumbs = crumbsFor(props.containerId);
  return crumbs.map((crumb, index) => {
    const collapsible = index < crumbs.length - 1 ? "max-sm:hidden" : undefined;
    const { agentId } = crumb;
    return (
      <Fragment key={crumb.key}>
        <WorkspaceBreadcrumbItem {...(collapsible ? { className: collapsible } : {})}>
          {agentId ? (
            <button
              type="button"
              aria-label={`Open the ${crumb.label} agent`}
              onClick={() => void navigate({ to: "/agent/$agentId", params: { agentId } })}
              className="min-w-0 cursor-pointer rounded-sm transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              <WorkspaceBreadcrumbText>{crumb.label}</WorkspaceBreadcrumbText>
            </button>
          ) : (
            <WorkspaceBreadcrumbText>{crumb.label}</WorkspaceBreadcrumbText>
          )}
        </WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbSeparator {...(collapsible ? { className: collapsible } : {})} />
      </Fragment>
    );
  });
}
