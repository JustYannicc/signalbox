import type { AutomationEventName } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Events understood by the cloud connector. A completed check is resolved to its current PR head. */
export const GITHUB_EVENTS = [
  "pull_request",
  "check_run",
  "check_suite",
  "pull_request_review",
  "pull_request_review_comment",
  "pull_request_review_thread",
  "issue_comment",
  "release",
  "issues",
] as const;

export const GITHUB_SIGNATURE = {
  header: "x-hub-signature-256",
  encoding: "hex",
  prefix: "sha256=",
} as const;

const Label = Schema.Struct({ name: Schema.String });
const User = Schema.NullOr(Schema.Struct({ login: Schema.String }));
const Numbered = Schema.Struct({ number: Schema.Number });
const Check = Schema.Struct({ head_sha: Schema.String, pull_requests: Schema.Array(Numbered) });
const Payload = Schema.Struct({
  action: Schema.optional(Schema.String),
  repository: Schema.Struct({ full_name: Schema.String }),
  pull_request: Schema.optional(
    Schema.Struct({ number: Schema.Number, merged: Schema.optional(Schema.Boolean) }),
  ),
  check_run: Schema.optional(Check),
  check_suite: Schema.optional(Check),
  issue: Schema.optional(
    Schema.Struct({
      number: Schema.Number,
      title: Schema.String,
      body: Schema.NullOr(Schema.String),
      html_url: Schema.String,
      labels: Schema.Array(Label),
      user: User,
      pull_request: Schema.optional(Schema.Unknown),
    }),
  ),
  release: Schema.optional(
    Schema.Struct({
      id: Schema.Number,
      tag_name: Schema.String,
      name: Schema.NullOr(Schema.String),
      html_url: Schema.String,
      prerelease: Schema.Boolean,
      published_at: Schema.NullOr(Schema.String),
    }),
  ),
  comment: Schema.optional(Schema.Unknown),
  review: Schema.optional(Schema.Unknown),
});
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Payload));
export type GitHubPayload = typeof Payload.Type;

export const parseGitHubPayload = (body: string) => Option.getOrNull(decode(body));

export interface GitHubSignal {
  readonly number: number | null;
  readonly events: ReadonlyArray<AutomationEventName>;
  readonly fields: Readonly<Record<string, unknown>>;
  /** A completed check on an older head cannot describe the PR's current checks. */
  readonly headSha?: string;
}

export function gitHubSignals(event: string, body: GitHubPayload): ReadonlyArray<GitHubSignal> {
  const action = body.action;
  if (event === "release" && action === "published" && body.release) {
    const release = body.release;
    return [
      {
        number: null,
        events: ["release.published"],
        fields: {
          release: {
            id: release.id,
            tag: release.tag_name,
            name: release.name,
            url: release.html_url,
            prerelease: release.prerelease,
            publishedAt: release.published_at,
          },
        },
      },
    ];
  }
  if (
    event === "issues" &&
    action === "opened" &&
    body.issue &&
    body.issue.pull_request === undefined
  ) {
    const issue = body.issue;
    return [
      {
        number: null,
        events: ["issue.opened"],
        fields: {
          number: issue.number,
          title: issue.title,
          body: issue.body,
          url: issue.html_url,
          labels: issue.labels.map((label) => label.name),
          author: issue.user?.login ?? null,
        },
      },
    ];
  }
  if ((event === "check_run" || event === "check_suite") && action === "completed") {
    const check = event === "check_run" ? body.check_run : body.check_suite;
    return (check?.pull_requests ?? []).map((pr) => ({
      number: pr.number,
      events: ["pr.checks.completed"],
      fields: {},
      headSha: check!.head_sha,
    }));
  }
  if (
    event === "issue_comment" &&
    ["created", "edited", "deleted"].includes(action ?? "") &&
    body.issue?.pull_request !== undefined
  )
    return [
      {
        number: body.issue.number,
        events: ["pr.commented"],
        fields: { comment: body.comment ?? null },
      },
    ];
  const pr = body.pull_request;
  if (!pr) return [];
  if (
    event === "pull_request_review" &&
    ["submitted", "edited", "dismissed"].includes(action ?? "")
  )
    return [
      { number: pr.number, events: ["pr.reviewed"], fields: { review: body.review ?? null } },
    ];
  if (
    event === "pull_request_review_comment" &&
    ["created", "edited", "deleted"].includes(action ?? "")
  )
    return [
      { number: pr.number, events: ["pr.commented"], fields: { comment: body.comment ?? null } },
    ];
  if (event === "pull_request_review_thread" && ["resolved", "unresolved"].includes(action ?? ""))
    return [{ number: pr.number, events: ["pr.updated"], fields: {} }];
  if (event !== "pull_request") return [];
  const events: AutomationEventName[] = ["pr.updated"];
  if (action === "opened" || action === "reopened") events.push("pr.opened");
  if (action === "closed") events.push(pr.merged ? "pr.merged" : "pr.closed");
  return [{ number: pr.number, events, fields: {} }];
}
