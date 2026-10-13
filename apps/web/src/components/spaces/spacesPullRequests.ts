/**
 * Pull requests live on their own page. A GitHub repository mapped into a Home
 * folder opens it (scoped to that folder's project when it is a real one), and
 * so does an item that points at a pull request. Same gate as that page: one
 * connected server offering pull requests is enough.
 */
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { useEnvironments } from "../../state/environments";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import type { SpacesMapping } from "./spacesMappings";
import { findSource } from "./spacesModel";

export function usePullRequestsSupported(): boolean {
  const { environments } = useEnvironments();
  return environments.some(
    (environment) => environment.serverConfig?.environment.capabilities.pullRequests === true,
  );
}

/** The saved list view, optionally opened on one pull request. */
export function pullRequestsSearch(target?: {
  readonly repository: string;
  readonly number: number;
}) {
  return { ...readPullRequestListPreferences(), ...target };
}

/** The real project a folder is, for scoping its repository's pull requests. */
export interface PullRequestScope {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
}

/** The saved list view scoped to one project, when the folder is a real one. */
export function projectPullRequestsSearch(scope: PullRequestScope | undefined) {
  return {
    ...readPullRequestListPreferences(),
    ...(scope ? { projectId: scope.id, environmentId: scope.environmentId } : {}),
  };
}

/** A mapped repository: its place is its pull requests. */
export function isPullRequestPlace(mapping: SpacesMapping): boolean {
  return mapping.what === "Repository" && findSource(mapping.source)?.connector === "github";
}
