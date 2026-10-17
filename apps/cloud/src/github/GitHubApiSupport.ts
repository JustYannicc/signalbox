import * as Schema from "effect/Schema";

export class GitHubError extends Schema.TaggedError<GitHubError>()("GitHubError", {
  operation: Schema.String,
  /** HTTP status, or 0 when no answer arrived. */
  status: Schema.Number,
  message: Schema.String,
  /** The protocol used for the request that produced this answer. */
  requestKind: Schema.optional(Schema.Literals(["rest", "graphql", "git"])),
  /** A short, sanitized excerpt of the response body, when an answer arrived. */
  responseExcerpt: Schema.optional(Schema.String),
  /** When GitHub's rate limit lets the caller ask again (epoch ms), when it said. */
  retryAt: Schema.optional(Schema.Number),
}) {}

/** An answer GitHub sent that doesn't decode as expected. */
export const unreadable = (operation: string) =>
  new GitHubError({
    operation,
    status: 200,
    message: "GitHub sent an answer Signalbox does not understand.",
  });

export interface GitHubEndpoints {
  /** Where OAuth and git live, e.g. `https://github.com`. */
  readonly web: string;
  /** The REST API, e.g. `https://api.github.com`. */
  readonly api: string;
  /** Attachment uploads; a stand-in is used only by local tests. */
  readonly uploads?: string;
}

export const defaultGitHubEndpoints: GitHubEndpoints = {
  web: "https://github.com",
  api: "https://api.github.com",
};
