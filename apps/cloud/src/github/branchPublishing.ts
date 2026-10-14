import type { PublishRequest, PublishResult } from "@signalbox/runner-protocol/BranchProtocol";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { remoteThreadWorktree } from "../user/contextProjects.ts";
import * as UserDrives from "../user/UserDrives.ts";
import { GitHubBranches } from "./GitHubBranches.ts";

/**
 * A thread's agent publishing its branch (`BranchProtocol.ts`), in the
 * thread's owner's object: the same `GitHubBranches.publish` the git panel's
 * Push and Create PR run, for the thread's own working tree, as the owner with
 * their contexts right now. The drive route already checked the thread's
 * drive token, which is where the thread and drive come from.
 */
export const publishBranch = (input: {
  readonly threadId: string;
  readonly driveId: string;
  readonly request: PublishRequest;
}) =>
  Effect.gen(function* () {
    const drives = yield* UserDrives.UserDrives;
    const branches = yield* GitHubBranches;
    const owner = yield* Effect.all(
      { userId: drives.userId, contextIds: drives.contextIds },
      { concurrency: 2 },
    ).pipe(Effect.option);
    if (owner._tag === "None" || owner.value.userId === null) {
      return {
        _tag: "failed",
        reason: "unavailable",
        message: "The thread's owner can't be read right now.",
      } satisfies PublishResult;
    }
    const { userId, contextIds } = owner.value;
    const { action, ...pullRequest } = input.request;
    const published = yield* branches
      .publish(
        { userId, contextIds },
        {
          cwd: remoteThreadWorktree(input.driveId, ThreadId.make(input.threadId)).path,
          openPullRequest: action === "create_pr",
          pullRequest,
        },
      )
      .pipe(Effect.result);
    if (published._tag === "Failure") {
      const { reason, message } = published.failure;
      return { _tag: "failed", reason, message } satisfies PublishResult;
    }
    const { branch, repository, push, pr } = published.success;
    return {
      _tag: "published",
      branch,
      repository,
      pushed: push.pushed,
      pullRequest:
        pr === null
          ? null
          : {
              number: pr.pr.number,
              url: pr.pr.url,
              title: pr.pr.title,
              baseBranch: pr.pr.baseRef,
              created: pr.created,
            },
    } satisfies PublishResult;
  });
