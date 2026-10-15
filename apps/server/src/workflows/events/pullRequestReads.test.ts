import { expect, it } from "@effect/vitest";
import { AutomationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { make } from "./pullRequestReads.ts";

const REF = { projectId: "project-1" as never, repository: "acme/app", number: 7 };

const comment = (id: string, login: string, at: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: "issue-comment" as const,
  author: { login },
  body: `${login} says ${id}`,
  createdAt: at,
  url: `https://github.com/acme/app/pull/7#${id}`,
  path: null,
  reviewState: null,
  ...extra,
});

/** A pull request service answering from fixed host data. */
const service = (input: { readonly fail?: boolean } = {}) =>
  ({
    invalidate: () => Effect.void,
    detail: () =>
      input.fail
        ? Effect.fail(new AutomationError({ message: "host down" }))
        : Effect.succeed({
            viewer: "Signalbox-Agent",
            author: { login: "someone" },
            checks: [
              { name: "lint", status: "failure", url: "https://ci/lint", description: null },
              { name: "test", status: "success", url: null, description: null },
              { name: "deploy", status: "action-required", url: null, description: null },
            ],
          }),
    activity: () =>
      Effect.succeed({
        comments: [
          comment("old", "reviewer", "2026-10-06T09:00:00Z"),
          comment("mine", "signalbox-agent", "2026-10-06T10:01:00Z"),
          comment("new", "reviewer", "2026-10-06T10:02:00Z"),
          // Edited after the watermark: counts as new activity.
          comment("edited", "bot", "2026-10-06T08:00:00Z", { editedAt: "2026-10-06T10:03:00Z" }),
        ],
        reviewThreads: [{ id: "thread-a", path: "src/a.ts", nextCommentsCursor: "page-2" }],
      }),
    threadComments: () =>
      Effect.succeed({
        comments: [comment("tail", "reviewer", "2026-10-06T10:04:00Z")],
        nextCursor: null,
      }),
  }) as never;

it.effect("remarks since a time leave out the account Signalbox reads with", () =>
  Effect.gen(function* () {
    const remarks = yield* make(service()).remarksSince(REF, "2026-10-06T10:00:00Z");
    expect(remarks?.map((remark) => [remark.id, remark.author, remark.kind, remark.path])).toEqual([
      ["new", "reviewer", "issue-comment", null],
      ["edited", "bot", "issue-comment", null],
      ["tail", "reviewer", "review-comment", "src/a.ts"],
    ]);
  }),
);

it.effect("failed checks list what needs someone; a failed read answers null", () =>
  Effect.gen(function* () {
    expect(yield* make(service()).failedChecks(REF)).toEqual([
      { name: "lint", status: "failure", url: "https://ci/lint" },
      { name: "deploy", status: "action-required", url: null },
    ]);
    expect(yield* make(service({ fail: true })).failedChecks(REF)).toBeNull();
  }),
);
