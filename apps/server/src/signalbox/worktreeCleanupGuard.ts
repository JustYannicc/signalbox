import {
  OrchestrationV2AppThreadJson,
  OrchestrationV2ProviderSessionJson,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as GitManager from "../git/GitManager.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import { threadHasQueuedTurnStart } from "../orchestration-v2/ThreadSettlementService.ts";

const decodeThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);
const decodeSession = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderSessionJson),
);
const FRESH_WORKTREE_GRACE_MS = 3 * 60 * 60 * 1_000;

export type WorktreeCleanupDeletedThread = {
  readonly thread: typeof OrchestrationV2AppThreadJson.Type;
  readonly workspaceRoot: string;
};

type CandidateThread =
  | OrchestrationV2ThreadShell
  | (WorktreeCleanupDeletedThread["thread"] & { readonly workspaceRoot: string });

type BindingRow = {
  readonly threadId: string;
  readonly deletedAt: string | null;
  readonly payloadJson: string;
  readonly hasPendingWork: number;
  readonly hasPendingDeletionEffect: number;
};

export type WorktreeCleanupGuardInput = {
  readonly worktreePath: string;
  readonly owner: CandidateThread;
  readonly branch: string;
  readonly headSha: string;
  readonly now: number;
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly deletedThreads: ReadonlyArray<WorktreeCleanupDeletedThread>;
};

export function worktreeCleanupFreshWorktree(
  threadCreatedAt: ReadonlyArray<number>,
  worktreeBirthtime: Date | null,
  gitLinkBirthtime: Date | null,
  now: number,
): boolean {
  if (worktreeBirthtime === null || gitLinkBirthtime === null) return true;
  const creationTimes = [
    ...threadCreatedAt,
    worktreeBirthtime.getTime(),
    gitLinkBirthtime.getTime(),
  ];
  if (
    threadCreatedAt.length === 0 ||
    creationTimes.some(
      (createdAt) => !Number.isFinite(createdAt) || createdAt <= 0 || createdAt > now,
    )
  )
    return true;
  return now - Math.max(...creationTimes) < FRESH_WORKTREE_GRACE_MS;
}

export function worktreeCleanupThreadIdle(
  thread: OrchestrationV2ThreadShell,
  now: number,
): boolean {
  return (
    thread.worktreePath !== null &&
    thread.activeRunId === null &&
    (thread.status === "idle" ||
      thread.status === "completed" ||
      thread.status === "interrupted" ||
      thread.status === "failed" ||
      thread.status === "cancelled" ||
      thread.status === "rolled_back") &&
    (thread.pendingBackgroundTasks?.length ?? 0) === 0 &&
    thread.pendingRuntimeRequest === null &&
    !threadHasQueuedTurnStart(thread, now)
  );
}

export function worktreeCleanupActivityAt(thread: OrchestrationV2ThreadShell): number {
  return Math.max(
    ...[
      thread.createdAt,
      thread.latestUserMessageAt,
      thread.latestRunRequestedAt,
      thread.latestRunStartedAt,
      thread.latestRunCompletedAt,
    ].flatMap((value) => (value == null ? [] : [DateTime.toEpochMillis(value)])),
  );
}

export function worktreeCleanupPositiveCompletion(
  thread: Pick<CandidateThread, "archivedAt">,
  pullRequest: Pick<GitManager.GitBranchPullRequest, "state" | "headRef" | "headSha"> | null,
  branch: string,
  headSha: string,
): boolean {
  return (
    thread.archivedAt !== null ||
    (pullRequest?.state === "merged" &&
      pullRequest.headRef === branch &&
      pullRequest.headSha === headSha)
  );
}

export class WorktreeCleanupGuard extends Context.Service<
  WorktreeCleanupGuard,
  {
    readonly check: (
      input: WorktreeCleanupGuardInput,
      options?: { readonly verifyCompletion?: boolean },
    ) => Effect.Effect<string | null>;
  }
>()("t3/signalbox/worktreeCleanupGuard") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const isWindows = yield* HostProcess.isWindows;
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const gitManager = yield* GitManager.GitManager;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const pathKey = (target: string) => {
    const resolved = path.resolve(target);
    return isWindows ? resolved.toLowerCase() : resolved;
  };
  const inside = (root: string, target: string) => {
    const relative = path.relative(pathKey(root), pathKey(target));
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };

  const bindingsFor = Effect.fn("WorktreeCleanupGuard.bindingsFor")(function* (
    worktreePath: string,
  ) {
    return yield* sql<BindingRow>`
      SELECT
        t.thread_id AS "threadId",
        t.deleted_at AS "deletedAt",
        t.payload_json AS "payloadJson",
        EXISTS (
          SELECT 1 FROM orchestration_v2_projection_runs r
          WHERE r.thread_id = t.thread_id
            AND r.status IN ('preparing', 'starting', 'running', 'waiting', 'queued')
        ) OR EXISTS (
          SELECT 1 FROM orchestration_v2_projection_runtime_requests request
          WHERE request.thread_id = t.thread_id AND request.status = 'pending'
        ) OR EXISTS (
          SELECT 1
          FROM orchestration_v2_projection_turn_items item
          LEFT JOIN orchestration_v2_projection_runs run ON run.run_id = item.run_id
          WHERE item.thread_id = t.thread_id
            AND item.type IN ('command_execution', 'dynamic_tool', 'subagent')
            AND item.status NOT IN ('completed', 'interrupted', 'failed', 'cancelled')
            AND (item.run_id IS NULL OR run.status <> 'rolled_back')
        ) AS "hasPendingWork",
        EXISTS (
          SELECT 1 FROM orchestration_v2_effect_outbox effect
          WHERE effect.thread_id = t.thread_id
            AND effect.status NOT IN ('succeeded', 'cancelled')
        ) AS "hasPendingDeletionEffect"
      FROM orchestration_v2_projection_threads t
      WHERE json_extract(t.payload_json, '$.worktreePath') = ${worktreePath}
    `;
  });

  const checkUnsafe = Effect.fn("WorktreeCleanupGuard.check")(function* (
    input: WorktreeCleanupGuardInput,
    options?: { readonly verifyCompletion?: boolean },
  ) {
    const bindings = yield* bindingsFor(input.worktreePath);
    const initialIds = new Set([
      ...input.threads.map((thread) => thread.id),
      ...input.deletedThreads.map((entry) => entry.thread.id),
    ]);
    if (
      bindings.length !== initialIds.size ||
      bindings.some((binding) => !initialIds.has(binding.threadId as ThreadId))
    )
      return "thread activity or shared worktree changed since check";

    const initialDeleted = new Map(
      input.deletedThreads.map((entry) => [entry.thread.id, entry.thread]),
    );
    const initialThreads = new Map(input.threads.map((thread) => [thread.id, thread]));
    const currentThreads: Array<OrchestrationV2ThreadShell> = [];
    const currentDeleted: Array<WorktreeCleanupDeletedThread["thread"]> = [];
    for (const binding of bindings) {
      const threadId = binding.threadId as ThreadId;
      const wasDeleted = initialDeleted.has(threadId);
      if ((binding.deletedAt !== null) !== wasDeleted)
        return "thread activity or shared worktree changed since check";
      if (binding.hasPendingWork !== 0 || binding.hasPendingDeletionEffect !== 0)
        return "thread is running or has pending work";

      if (wasDeleted) {
        const current = yield* decodeThread(binding.payloadJson);
        const previous = initialDeleted.get(threadId);
        if (
          previous === undefined ||
          current.branch !== previous.branch ||
          current.worktreePath !== previous.worktreePath ||
          !Equal.equals(current.archivedAt, previous.archivedAt) ||
          !Equal.equals(current.createdAt, previous.createdAt) ||
          !Equal.equals(current.updatedAt, previous.updatedAt)
        )
          return "thread activity or shared worktree changed since check";
        currentDeleted.push(current);
        continue;
      }

      const current = yield* projections.getThreadShell(threadId);
      const previous = initialThreads.get(threadId);
      if (current === null || previous === undefined)
        return "thread activity or shared worktree changed since check";
      if (
        current.branch !== previous.branch ||
        current.worktreePath !== previous.worktreePath ||
        !Equal.equals(current.archivedAt, previous.archivedAt) ||
        !Equal.equals(current.settledAt, previous.settledAt) ||
        (current.settledAt !== null && !Equal.equals(current.updatedAt, previous.updatedAt)) ||
        !worktreeCleanupThreadIdle(current, input.now) ||
        worktreeCleanupActivityAt(current) !== worktreeCleanupActivityAt(previous)
      )
        return "thread activity or shared worktree changed since check";
      currentThreads.push(current);
    }

    const currentOwner =
      currentThreads.find((thread) => thread.id === input.owner.id) ??
      currentDeleted.find((thread) => thread.id === input.owner.id);
    if (
      currentOwner === undefined ||
      currentOwner.branch !== input.branch ||
      currentOwner.worktreePath === null ||
      path.resolve(currentOwner.worktreePath) !== input.worktreePath
    )
      return "thread activity or shared worktree changed since check";

    const threadCreatedAt = [
      ...currentThreads.map((thread) => DateTime.toEpochMillis(thread.createdAt)),
      ...currentDeleted.map((thread) => DateTime.toEpochMillis(thread.createdAt)),
    ];
    const worktreeBirthtime = Option.getOrNull((yield* fs.stat(input.worktreePath)).birthtime);
    const gitLinkBirthtime = Option.getOrNull(
      (yield* fs.stat(path.join(input.worktreePath, ".git"))).birthtime,
    );
    if (
      worktreeCleanupFreshWorktree(threadCreatedAt, worktreeBirthtime, gitLinkBirthtime, input.now)
    )
      return "worktree is younger than three hours or its creation time is unknown";

    if (currentOwner.archivedAt === null && options?.verifyCompletion !== false) {
      const pullRequest = yield* gitManager.branchPullRequest(
        { cwd: input.worktreePath, branch: input.branch },
        { refresh: true },
      );
      if (
        !worktreeCleanupPositiveCompletion(currentOwner, pullRequest, input.branch, input.headSha)
      )
        return "thread needs to be archived or its pull request merged";
    }

    const sessionRows = yield* sql<{ payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_projection_provider_sessions
      WHERE status != 'stopped'
    `;
    for (const session of yield* Effect.forEach(sessionRows, (row) =>
      decodeSession(row.payload_json),
    )) {
      const cwd = path.resolve(session.cwd);
      if (
        (pathKey(cwd) === pathKey(input.worktreePath) || inside(input.worktreePath, cwd)) &&
        (yield* providerSessions.isLive(session.id))
      )
        return "provider session is still open";
    }
    return null;
  });
  const check: WorktreeCleanupGuard["Service"]["check"] = (input, options) =>
    checkUnsafe(input, options).pipe(
      Effect.catch((error) =>
        Effect.logWarning("worktree cleanup safety check failed", { error }).pipe(
          Effect.as("could not verify worktree cleanup safety"),
        ),
      ),
    );

  return WorktreeCleanupGuard.of({ check });
});

export const layer = Layer.effect(WorktreeCleanupGuard, make);
