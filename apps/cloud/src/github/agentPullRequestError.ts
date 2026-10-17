import * as Schema from "effect/Schema";

import type { GitHubError } from "./GitHubApi.ts";

const ERROR_CATEGORIES = [
  "invalid",
  "permission",
  "not_connected",
  "not_found",
  "conflict",
  "pending",
  "github_conflict",
  "unavailable",
] as const;

export class AgentPullRequestError extends Schema.TaggedError<AgentPullRequestError>()(
  "AgentPullRequestError",
  {
    category: Schema.Literals(ERROR_CATEGORIES),
    /** GitHub's status, or zero for a local refusal. Never includes provider text. */
    status: Schema.Number,
    retryAt: Schema.optional(Schema.Number),
  },
) {
  override get message(): string {
    switch (this.category) {
      case "invalid":
        return "The pull request request is invalid.";
      case "permission":
        return "You don't have access to this pull request or folder.";
      case "not_connected":
        return "Connect GitHub before using pull request tools.";
      case "not_found":
        return "This pull request could not be found.";
      case "conflict":
        return "This operation id was already used for different content.";
      case "pending":
        return "This write may have reached GitHub. Read the pull request before trying another operation id.";
      case "github_conflict":
        return "GitHub rejected this pull request change.";
      case "unavailable":
        return "GitHub is unavailable right now. Try again.";
    }
  }
}

export const isAgentPullRequestError = Schema.is(AgentPullRequestError);

export const errorForCategory = (
  category: AgentPullRequestError["category"],
  status = 0,
  retryAt?: number,
) =>
  new AgentPullRequestError({
    category,
    status,
    ...(retryAt === undefined ? {} : { retryAt }),
  });

const categoryForStatus = (status: number): AgentPullRequestError["category"] => {
  if (status === 401) return "not_connected";
  if (status === 403) return "permission";
  if (status === 404) return "not_found";
  if (status === 409 || status === 422) return "github_conflict";
  return "unavailable";
};

export const safeApiError = (error: Pick<GitHubError, "status" | "retryAt">) =>
  errorForCategory(
    error.retryAt === undefined ? categoryForStatus(error.status) : "unavailable",
    error.status,
    error.retryAt,
  );
