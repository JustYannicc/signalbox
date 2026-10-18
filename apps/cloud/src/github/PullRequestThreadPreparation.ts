import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  GitManagerError,
  ThreadId,
  type GitPreparePullRequestThreadInput,
  type GitPreparePullRequestThreadResult,
} from "@t3tools/contracts";
import { canWriteDrive } from "@t3tools/contracts/signalboxDrives";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { threadPullRequestsOf } from "@t3tools/shared/threadPullRequests";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Schema from "effect/Schema";

import { DriveDirectory } from "../drive/DriveDirectory.ts";
import { CloudThreadService } from "../thread/CloudThreadService.ts";
import type { Actor } from "../thread/ThreadAccess.ts";
import { UserDrives } from "../user/UserDrives.ts";
import {
  driveOfRoot,
  projectOfDrive,
  remoteThreadWorktree,
  threadWorktreeAt,
} from "../user/contextProjects.ts";
import { GitHub } from "./GitHub.ts";
import { ownerAndName } from "./GitHubPullRequests.ts";
import { PullRequestRepository } from "./PullRequestRepository.ts";
import { makePullRequestThreadReservations } from "./PullRequestThreadReservations.ts";
import { makeCollaborationQuery } from "./pullRequestCollaborationSupport.ts";

const preparationQuery = `query PullRequestThreadPreparation($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number title url state baseRefName headRefName headRefOid
    }
  }
}`;
const PreparationData = Schema.Struct({
  repository: Schema.NullOr(
    Schema.Struct({
      pullRequest: Schema.NullOr(
        Schema.Struct({
          number: Schema.Number,
          title: Schema.String,
          url: Schema.String,
          state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
          baseRefName: Schema.String,
          headRefName: Schema.String,
          headRefOid: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
        }),
      ),
    }),
  ),
});
const encodeRequestKey = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      cwd: Schema.String,
      reference: Schema.String,
      mode: Schema.String,
      threadId: Schema.NullOr(ThreadId),
    }),
  ),
);
const encodeIdentity = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      userId: Schema.String,
      operationId: Schema.String,
    }),
  ),
);

/** Pins a PR and its destination before any child object changes; preparing never sends a turn. */
export const makePullRequestThreadPreparation = Effect.gen(function* () {
  const drives = yield* UserDrives;
  const repositories = yield* PullRequestRepository;
  const github = yield* GitHub;
  const threads = yield* CloudThreadService;
  const directory = yield* Effect.serviceOption(DriveDirectory);
  const crypto = yield* Crypto.Crypto;
  const reservations = yield* makePullRequestThreadReservations;
  const query = makeCollaborationQuery(github.api);

  return (actor: Actor, input: GitPreparePullRequestThreadInput) => {
    const refuse = (detail: string) =>
      Effect.fail(
        new GitManagerError({ operation: "preparePullRequestThread", cwd: input.cwd, detail }),
      );
    return Effect.gen(function* () {
      if (!input.operationId)
        return yield* refuse("Preparation needs an operation id for retries.");
      const operationId = input.operationId;
      const userId = yield* drives.userId;
      const driveId =
        threadWorktreeAt(input.cwd)?.driveId ??
        (userId === null ? null : driveOfRoot(input.cwd, userId));
      const projectId =
        driveId === null || userId === null ? null : projectOfDrive(driveId, userId);
      if (
        userId !== actor.userId ||
        driveId === null ||
        projectId === null ||
        directory._tag === "None" ||
        !canWriteDrive(yield* drives.access(driveId))
      )
        return yield* refuse("You don't have access to prepare a thread in this folder.");
      const target = yield* repositories.forProject(projectId);
      const parsed = parseChangeRequestUrl(input.reference);
      const number =
        parsed?.number ??
        (/^#?[1-9]\d*$/.test(input.reference) ? Number(input.reference.replace(/^#/, "")) : NaN);
      if (
        !Number.isSafeInteger(number) ||
        number < 1 ||
        (parsed !== null &&
          (parsed.host !== target.host ||
            parsed.repository.toLowerCase() !== target.repository.toLowerCase()))
      )
        return yield* refuse("Choose a pull request from this folder's repository.");

      const requestKey = encodeRequestKey({
        cwd: input.cwd,
        reference: input.reference,
        mode: input.mode,
        threadId: input.threadId ?? null,
      });
      let reservation = yield* reservations.read(operationId);
      if (reservation === null) {
        const data = yield* query(
          target.token,
          preparationQuery,
          { ...ownerAndName(target.repository), number },
          PreparationData,
        );
        const pr = data.repository?.pullRequest;
        if (pr == null || pr.number !== number || pr.state !== "OPEN")
          return yield* refuse("Choose an open pull request with an available head.");
        const threadId =
          input.threadId ??
          ThreadId.make(
            `pr-thread:${Hex.encode(yield* crypto.digest("SHA-256", new TextEncoder().encode(encodeIdentity({ userId, operationId }))))}`,
          );
        reservation = yield* reservations.reserve(operationId, requestKey, {
          projectId,
          driveId,
          threadId,
          repository: target.repository,
          host: target.host,
          accountId: target.accountId,
          headSha: pr.headRefOid,
          pullRequest: {
            number: pr.number,
            title: pr.title,
            url: pr.url,
            baseBranch: pr.baseRefName,
            headBranch: pr.headRefName,
            state: "open",
          },
        });
      }
      if (reservation === null || reservation.request_key !== requestKey)
        return yield* refuse("This operation id already names a different preparation.");
      const selected = reservation.selection;
      if (
        selected.projectId !== projectId ||
        selected.driveId !== driveId ||
        selected.repository.toLowerCase() !== target.repository.toLowerCase() ||
        selected.host !== target.host ||
        selected.accountId !== target.accountId
      )
        return yield* refuse("The folder or GitHub account changed. Start a new preparation.");

      const existing = yield* threads
        .threadSnapshot(actor, selected.threadId)
        .pipe(Effect.catchTags({ ThreadNotFoundError: () => Effect.succeed(null) }));
      if (existing !== null && existing.projection.thread.projectId !== selected.projectId)
        return yield* refuse("That thread belongs to a different folder.");
      if (
        existing !== null &&
        threadPullRequestsOf(existing.projection.thread).some(
          (link) =>
            link.host.toLowerCase() !== selected.host.toLowerCase() ||
            link.repository.toLowerCase() !== selected.repository.toLowerCase() ||
            link.number !== selected.pullRequest.number,
        )
      )
        return yield* refuse("That thread is already linked to a different pull request.");
      if (reservation.completed !== 0 && existing === null)
        return yield* refuse("The prepared thread is no longer available.");
      if (reservation.completed === 0) {
        if (
          reservation.launch_started === 0 &&
          existing !== null &&
          existing.projection.runs.length > 0
        )
          return yield* refuse("This thread has already started work. Prepare a new thread.");
        const seeded = yield* directory.value.forDrive(driveId).prepareThread(userId, {
          operationId,
          threadId: selected.threadId,
          repository: selected.repository,
          number: selected.pullRequest.number,
          headSha: selected.headSha,
        });
        if (seeded._tag === "refused")
          return yield* refuse("The thread's workspace is already in use or its source changed.");
        yield* reservations.launching(operationId);
        yield* threads.launchThread(actor, {
          commandId: CommandId.make(`prepare-pr:${operationId}`),
          threadId: selected.threadId,
          ...(existing === null ? {} : { reuseExistingThread: true }),
          projectId: selected.projectId,
          title: selected.pullRequest.title,
          runtimeMode: DEFAULT_SERVER_SETTINGS.defaultRuntimeMode,
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
        });
        yield* threads.dispatchCommand(actor, {
          type: "thread.pull-request.link",
          commandId: CommandId.make(`prepare-pr-link:${operationId}`),
          threadId: selected.threadId,
          repository: selected.repository,
          host: selected.host,
          number: selected.pullRequest.number,
          url: selected.pullRequest.url,
          source: "manual",
        });
        yield* reservations.complete(operationId);
      }
      const workspace = remoteThreadWorktree(driveId, selected.threadId);
      return {
        pullRequest: selected.pullRequest,
        branch: workspace.branch,
        worktreePath: workspace.path,
        threadId: selected.threadId,
        isOnPullRequestHead: true,
      } satisfies GitPreparePullRequestThreadResult;
    }).pipe(
      Effect.catchTags({
        SqlError: () =>
          refuse("Could not retain this preparation. Retry with the same operation id."),
        PlatformError: () =>
          refuse("Could not retain this preparation. Retry with the same operation id."),
        AgentPullRequestError: (error) => refuse(error.message),
        PullRequestOperationError: (error) => refuse(error.message),
        PullRequestUnavailableError: () =>
          refuse("Connect GitHub before preparing a pull request thread."),
        ThreadCommandRejectedError: (error) => refuse(error.message),
        ThreadNotFoundError: () => refuse("The prepared thread is no longer available."),
        ThreadObjectError: () =>
          refuse("The thread is unavailable. Retry with the same operation id."),
        DriveObjectError: () =>
          refuse("The drive is unavailable. Retry with the same operation id."),
      }),
    );
  };
});
