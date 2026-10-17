import type {
  PublishFailureReason,
  PublishRequest,
} from "@signalbox/runner-protocol/BranchProtocol";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { RunnerDrive } from "./RunnerDrive.ts";
import { fail, json, register } from "./RunnerContextTools.ts";
import type { DrivesView } from "./RunnerDrivesView.ts";

/**
 * Publishing the thread's own branch from the context server (#135), named
 * like the git panel's actions: `push`, and `create_pr` to push and open its
 * pull request. The machine holds no credential for the remote, so `git push`
 * can't work here (fetching, pulling and rebasing do, #394): the Runner saves
 * the branch to the drive with whatever is uncommitted, then asks the cloud,
 * with the turn's drive token, to push it as the thread's owner. The cloud
 * acts only on the thread the token names. A branch that took the remote
 * branch's head in and rewrote it (a rebase) replaces that head, and nothing
 * newer: the lease.
 */

/** What publishing needs of the thread's drive. */
export type BranchDrive = Pick<RunnerDrive, "saveBranch" | "published">;

/** A refusal as the agent should read it: what happened, and what to do about it. */
const explain = (reason: PublishFailureReason, message: string) => {
  switch (reason) {
    case "not_connected":
      return "GitHub isn't connected. Ask the user to connect it in Settings › Source Control, then try again.";
    case "no_permission":
      return `${message} Ask the user to check their GitHub account can write to this repository.`;
    case "branch_conflict":
      return `${message} Run \`git pull --rebase\` to take them in (resolve any conflict), then push again.`;
    case "unavailable":
      return `${message} Try again in a little while.`;
    case "not_a_repository":
    case "nothing_saved":
    case "rejected":
      return message;
  }
};

const CommitMessage = Schema.String.annotate({
  description:
    "The commit message for changes not committed yet. Defaults to a summary of the changed files.",
});

/** The publishing tools, saving through `drive()` and asking the cloud through `view`'s client. */
export const layerBranchTools = (view: DrivesView, drive: () => BranchDrive | null) => {
  const publish = (request: PublishRequest, commitMessage: string | undefined) =>
    Effect.gen(function* () {
      const client = view.client();
      const current = drive();
      if (client === null || current === null) {
        return yield* fail("This thread has no drive to publish; it opens with the thread's turn.");
      }
      const saved = yield* current
        .saveBranch(commitMessage)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("saving the branch to publish failed", Cause.pretty(cause)).pipe(
              Effect.andThen(fail("Saving this thread's work failed, so nothing was pushed.")),
            ),
          ),
        );
      if (saved._tag === "not_saved") return yield* fail(saved.reason);
      const result = yield* client.publish(
        saved.lease === null ? request : { ...request, lease: saved.lease },
      );
      if (result._tag === "failed") return yield* fail(explain(result.reason, result.message));
      const { branch, repository, pushed, pullRequest } = result;
      // GitHub has the branch at this head now: the next push's lease.
      yield* current.published(saved.head).pipe(Effect.ignore);
      return json({ branch, repository, commit: saved.head, pushed, pullRequest });
    });

  const writes = { destructive: false, openWorld: true } as const;
  return Layer.effectDiscard(
    Effect.all([
      register({
        name: "push",
        description:
          "Push this thread's branch to its GitHub repository, as the git panel's Push does. Uncommitted changes are committed first. Use this instead of `git push`, which has no credential here: Signalbox pushes with the user's GitHub connection. `git fetch`, `git pull` and `git rebase origin/main` work as usual; after rebasing, this replaces the branch on GitHub as long as it holds nothing you haven't fetched. Answers the branch, the repository and the pushed commit. Only in a project backed by a GitHub repository.",
        parameters: Schema.Struct({ commitMessage: Schema.optional(CommitMessage) }),
        writes,
        handle: ({ commitMessage }) => publish({ action: "push" }, commitMessage),
      }),
      register({
        name: "create_pr",
        description:
          "Push this thread's branch and open its pull request into the repository's default branch, as the git panel's Create PR does; when the branch already has an open pull request, answers that one. Uncommitted changes are committed first. Use this instead of `git push` or `gh pr create`, which have no credential here. Answers the pull request's number and URL. Only in a project backed by a GitHub repository.",
        parameters: Schema.Struct({
          title: Schema.optional(
            Schema.String.annotate({
              description: "The pull request's title. Defaults to the thread's title.",
            }),
          ),
          body: Schema.optional(
            Schema.String.annotate({
              description: "The pull request's description, in Markdown: what changed and why.",
            }),
          ),
          draft: Schema.optional(
            Schema.Boolean.annotate({ description: "Open it as a draft. Defaults to false." }),
          ),
          commitMessage: Schema.optional(CommitMessage),
        }),
        writes,
        handle: ({ commitMessage, ...pullRequest }) =>
          publish({ action: "create_pr", ...pullRequest }, commitMessage),
      }),
    ]),
  );
};
