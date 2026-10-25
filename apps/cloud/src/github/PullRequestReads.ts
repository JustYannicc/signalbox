import type { PullRequestCheck, PullRequestCommentKind, PullRequestRef } from "@t3tools/contracts";
import { ellipsize } from "@t3tools/shared/String";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { GitHub } from "./GitHub.ts";
import { GitHubConnection } from "./GitHubConnection.ts";
import { pullRequestChecks, pullRequestRemarks } from "./GitHubPullRequests.ts";

/**
 * The host reads behind `pr.commented`, `pr.reviewed` and the failed checks
 * on `pr.checks.failed`, acting with the user's own GitHub connection.
 * A check counts as failed and a remark as new
 * by upstream's PR watch rules (`evaluatePullRequestWatch`). A read that fails
 * or takes too long answers null, so the event still goes, without details.
 */

/** A comment or review, as the event carries it. */
export interface Remark {
  readonly id: string;
  readonly kind: PullRequestCommentKind;
  readonly author: string | null;
  readonly body: string | null;
  readonly path: string | null;
  readonly reviewState: string | null;
  readonly url: string | null;
  readonly at: string;
}

export interface FailedCheck {
  readonly name: string;
  readonly status: PullRequestCheck["status"];
  readonly url: string | null;
}

export class PullRequestReads extends Context.Service<
  PullRequestReads,
  {
    /** Remarks by others than the account Signalbox reads with, active after `since`, oldest first. */
    readonly remarksSince: (
      ref: PullRequestRef,
      since: string,
    ) => Effect.Effect<ReadonlyArray<Remark> | null>;
    readonly failedChecks: (
      ref: PullRequestRef,
    ) => Effect.Effect<ReadonlyArray<FailedCheck> | null>;
  }
>()("@signalbox/cloud/github/PullRequestReads") {}

/** Event delivery waits on these reads, so a slow host only costs the details. */
const READ_TIMEOUT = "20 seconds";
/** The engine's `SHORT_TEXT`: a remark's body as an event carries it. */
const BODY_LIMIT = 4_000;

// "action-required" is a finished check that needs someone, as upstream's watch reads it.
const isFailedCheck = (check: PullRequestCheck) =>
  check.status === "failure" || check.status === "cancelled" || check.status === "action-required";

/** Hidden markup bots leave in comments isn't worth an agent's attention. */
const visibleText = (body: string) =>
  body
    .replaceAll(/<!--[\s\S]*?-->/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();

const make = Effect.gen(function* () {
  const github = yield* GitHub;
  const connection = yield* GitHubConnection;

  /** Runs `read` with the user's token on a pull request this GitHub hosts; null otherwise. */
  const withToken =
    (what: string) =>
    <A, E>(ref: PullRequestRef, read: (token: string) => Effect.Effect<A | null, E>) =>
      Effect.gen(function* () {
        if (ref.host !== undefined && ref.host.toLowerCase() !== github.api.host) return null;
        const token = yield* connection.accessToken;
        return token === null ? null : yield* read(token);
      }).pipe(
        Effect.timeoutOption(READ_TIMEOUT),
        Effect.map(Option.getOrNull),
        Effect.catchCause((cause) =>
          Effect.logWarning(`Automation pull request ${what} read failed`, { cause }).pipe(
            Effect.as(null),
          ),
        ),
        Effect.withSpan(`PullRequestReads.${what}`),
      );

  const remarksSince: PullRequestReads["Service"]["remarksSince"] = (ref, since) =>
    withToken("conversation")(ref, (token) =>
      Effect.gen(function* () {
        const [viewer, remarks] = yield* Effect.all(
          [
            github.api.viewer(token),
            pullRequestRemarks(github.api, token, ref.repository, ref.number, since),
          ],
          { concurrency: 2 },
        );
        if (remarks === null) return null;
        // Its own remarks never count: they're what the automation's agent said.
        const own = viewer?.login.toLowerCase() ?? null;
        const after = Date.parse(since);
        return (
          remarks
            .filter((remark) => remark.author?.toLowerCase() !== own)
            .map((remark): Remark => ({
              id: remark.id,
              kind: remark.kind,
              author: remark.author,
              body: ellipsize(visibleText(remark.body), BODY_LIMIT),
              path: remark.path,
              reviewState: remark.reviewState,
              url: remark.url,
              at: remark.editedAt ?? remark.createdAt,
            }))
            // Strictly after: a remark at `since` itself was told then.
            .filter((remark) => Date.parse(remark.at) > after)
            .toSorted((left, right) => left.at.localeCompare(right.at))
        );
      }),
    );

  const failedChecks: PullRequestReads["Service"]["failedChecks"] = (ref) =>
    withToken("checks")(ref, (token) =>
      Effect.map(pullRequestChecks(github.api, token, ref.repository, ref.number), (checks) =>
        checks === null
          ? null
          : checks
              .filter(isFailedCheck)
              .map((check) => ({ name: check.name, status: check.status, url: check.url })),
      ),
    );

  return PullRequestReads.of({ remarksSince, failedChecks });
});

/** In the user's object, beside their GitHub connection. */
export const layer = Layer.effect(PullRequestReads, make);
