import { AutomationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { type GitHubApi } from "../GitHubApi.ts";
import { type GitHubOperationJournal, type IssueAttemptKey } from "../githubOperationJournal.ts";
import {
  decodeJson,
  failed,
  knownRejection,
  pendingIssue,
  safeUrl,
  validateRepository,
  validCorrelationId,
} from "./common.ts";
import { type IssueBody, makeWorkflowRest } from "./rest.ts";
import type { CreateIssueInput, GitHubIssue } from "./types.ts";

const IssueResult = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
});
const isAutomationError = Schema.is(AutomationError);

const issueMarker = (projectId: string, correlationId: string) =>
  "<!-- signalbox:github-issue:v1:" +
  encodeURIComponent(projectId) +
  ":" +
  encodeURIComponent(correlationId) +
  " -->";

const decodeIssue = (text: string | null, marker: string): GitHubIssue | null => {
  if (text === null) return null;
  const body = decodeJson(
    Schema.Struct({
      number: Schema.Number,
      title: Schema.String,
      html_url: Schema.String,
      body: Schema.NullOr(Schema.String),
      pull_request: Schema.optional(Schema.Unknown),
    }),
    text,
  );
  if (
    body === null ||
    body.pull_request !== undefined ||
    !Number.isSafeInteger(body.number) ||
    body.number < 1 ||
    !safeUrl(body.html_url) ||
    body.body === null ||
    !body.body.includes(marker)
  )
    return null;
  return { number: body.number, title: body.title, url: body.html_url };
};

const decodeStoredIssue = (text: string) => {
  const issue = decodeJson(IssueResult, text);
  if (
    issue === null ||
    !Number.isSafeInteger(issue.number) ||
    issue.number < 1 ||
    !safeUrl(issue.url)
  )
    return null;
  return issue satisfies GitHubIssue;
};

export const makeCreateIssue = (api: GitHubApi, journal: GitHubOperationJournal) => {
  const rest = makeWorkflowRest(api);

  const matchingIssues = (token: string, repository: string, marker: string) =>
    rest
      .issues(token, repository)
      .pipe(
        Effect.map((issues) =>
          issues.filter(
            (issue) =>
              issue.pull_request === undefined &&
              issue.body !== null &&
              issue.body.includes(marker),
          ),
        ),
      );

  const issueOf = (body: IssueBody, marker: string): GitHubIssue | null => {
    if (
      body.pull_request !== undefined ||
      body.body === null ||
      !body.body.includes(marker) ||
      !Number.isSafeInteger(body.number) ||
      body.number < 1 ||
      !safeUrl(body.html_url)
    )
      return null;
    return { number: body.number, title: body.title, url: body.html_url };
  };

  const acceptExistingIssue = (token: string, repository: string, marker: string) =>
    matchingIssues(token, repository, marker).pipe(
      Effect.flatMap((issues) => {
        if (issues.length > 1)
          return Effect.fail(failed("More than one GitHub issue has this correlation marker."));
        const candidate = issues[0];
        if (candidate === undefined) return Effect.succeed(null);
        const issue = issueOf(candidate, marker);
        return issue === null
          ? Effect.fail(failed("The issue with this correlation marker is unreadable."))
          : Effect.succeed(issue);
      }),
    );

  const finishIssue = (key: IssueAttemptKey, requestHash: string, issue: GitHubIssue) =>
    journal.completeIssue({ ...key, requestHash, result: issue }).pipe(Effect.as(issue));

  const completeIssueAttempt = (
    token: string,
    repository: string,
    key: IssueAttemptKey,
    marker: string,
    requestHash: string,
  ) =>
    acceptExistingIssue(token, repository, marker).pipe(
      Effect.flatMap((issue) =>
        issue === null ? Effect.fail(pendingIssue()) : finishIssue(key, requestHash, issue),
      ),
    );

  const recoverUncertainIssue = (
    token: string,
    repository: string,
    key: IssueAttemptKey,
    marker: string,
    requestHash: string,
  ) =>
    Effect.result(acceptExistingIssue(token, repository, marker)).pipe(
      Effect.flatMap((readback) =>
        readback._tag === "Failure"
          ? Effect.fail(
              failed(
                "Issue creation outcome is unknown and GitHub readback failed; the durable attempt stays pending.",
                readback.failure,
              ),
            )
          : readback.success === null
            ? Effect.fail(pendingIssue())
            : finishIssue(key, requestHash, readback.success),
      ),
    );

  return (token: string, repository: string, projectId: string, input: CreateIssueInput) =>
    Effect.gen(function* () {
      if (!validateRepository(repository))
        return yield* failed("The folder's GitHub repository name is invalid.");
      if (!validCorrelationId(input.correlationId))
        return yield* failed("Pass a non-empty correlation ID of at most 256 characters.");
      const marker = issueMarker(projectId, input.correlationId);
      if (input.body.includes(marker))
        return yield* failed("The issue body already contains its reserved correlation marker.");

      const key: IssueAttemptKey = { projectId, repository, correlationId: input.correlationId };
      const attempt = yield* journal.claimIssue({
        ...key,
        request: { title: input.title, body: input.body },
      });
      if (attempt._tag === "completed") {
        const saved = decodeStoredIssue(attempt.resultJson);
        if (saved === null) return yield* failed("The saved issue result is unreadable.");
        return saved;
      }
      if (attempt._tag === "pending")
        return yield* completeIssueAttempt(token, repository, key, marker, attempt.requestHash);

      const existing = yield* acceptExistingIssue(token, repository, marker).pipe(
        Effect.catch((error) =>
          journal
            .releaseIssue({ ...key, requestHash: attempt.requestHash })
            .pipe(Effect.flatMap(() => Effect.fail(error))),
        ),
      );
      if (existing !== null) return yield* finishIssue(key, attempt.requestHash, existing);

      const body = input.body.length === 0 ? marker : input.body + "\n\n" + marker;
      const response = yield* Effect.result(
        rest.createIssue(token, repository, { title: input.title, body }),
      );
      if (response._tag === "Failure") {
        if (knownRejection(response.failure)) {
          yield* journal.releaseIssue({ ...key, requestHash: attempt.requestHash });
          return yield* response.failure;
        }
        return yield* recoverUncertainIssue(token, repository, key, marker, attempt.requestHash);
      }
      if (response.success === null) {
        yield* journal.releaseIssue({ ...key, requestHash: attempt.requestHash });
        return yield* failed("GitHub could not find the repository for issue creation.");
      }

      const created = decodeIssue(response.success, marker);
      if (created !== null) return yield* finishIssue(key, attempt.requestHash, created);
      return yield* recoverUncertainIssue(token, repository, key, marker, attempt.requestHash);
    }).pipe(
      Effect.mapError((cause) =>
        isAutomationError(cause) ? cause : failed("Couldn't create the GitHub issue.", cause),
      ),
    );
};
