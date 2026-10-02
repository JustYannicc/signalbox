/**
 * Pull requests live on their own page; Spaces links into it. Same gate as
 * that page: one connected server offering pull requests is enough.
 */
import { useEnvironments } from "../../state/environments";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";

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
