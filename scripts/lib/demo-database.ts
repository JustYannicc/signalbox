// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Host-side fixture that writes demo projections.
/**
 * Writes the demo dataset straight into a migrated state DB's projection
 * tables and owns the demo home layout. See `scripts/demo-environment.ts`.
 */
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import {
  DEMO_MODEL_BY_PROVIDER,
  DEMO_PROJECTS,
  DEMO_THREADS,
  type DemoProject,
  type DemoThread,
} from "./demo-dataset.ts";
import { buildThreadActivities, demoRequestId, type DemoTurnWindow } from "./demo-activities.ts";

const EXCHANGE_GAP_MINUTES = 40;

const PROJECT_SCRIPTS = JSON.stringify([
  { id: "dev", name: "Dev", command: "pnpm dev", icon: "play", runOnWorktreeCreate: false },
  { id: "test", name: "Tests", command: "pnpm test", icon: "test", runOnWorktreeCreate: false },
]);

// Everything the seeder owns. Auth tables and the environment id survive a refresh.
const SEEDED_TABLES = [
  "orchestration_events",
  "orchestration_command_receipts",
  "checkpoint_diff_blobs",
  "provider_session_runtime",
  "projection_pending_approvals",
  "projection_thread_pull_requests",
  "projection_thread_proposed_plans",
  "projection_thread_activities",
  "projection_thread_messages",
  "projection_thread_sessions",
  "projection_turns",
  "projection_threads",
  "projection_projects",
  "projection_state",
] as const;

export const demoPaths = (home: string) => ({
  dbPath: NodePath.join(home, "userdata", "state.sqlite"),
  runtimeStatePath: NodePath.join(home, "userdata", "server-runtime.json"),
  repoRoot: (project: DemoProject) => NodePath.join(home, "demo-repos", project.directory),
  worktree: (thread: DemoThread) =>
    NodePath.join(
      home,
      "worktrees",
      thread.projectId,
      (thread.branch ?? thread.id).replaceAll("/", "-"),
    ),
});

const at = (now: number, minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
function pullRequestUrl(project: DemoProject, number: number): string {
  const remote = project.remote;
  if (!remote) throw new Error(`${project.id} has no remote for a pull request.`);
  return remote.host === "gitlab.com"
    ? `https://gitlab.com/${remote.repository}/-/merge_requests/${number}`
    : `https://github.com/${remote.repository}/pull/${number}`;
}

/** A captured checkpoint for one turn, as `projection_turns` stores it. */
export interface DemoCheckpointRecord {
  readonly turnCount: number;
  readonly ref: string;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly kind: "modified";
    readonly additions: number;
    readonly deletions: number;
  }>;
}

/** Checkpoints per thread id, indexed by exchange; null where a turn has none. */
export type DemoCheckpointIndex = ReadonlyMap<string, ReadonlyArray<DemoCheckpointRecord | null>>;

const LATEST_TURN_STATE: Record<DemoThread["state"], string> = {
  running: "running",
  failed: "error",
  interrupted: "interrupted",
  approval: "completed",
  input: "completed",
  plan: "completed",
  done: "completed",
};

/** Minutes-ago windows per turn: asked at `start`, answered at `end`. */
export function demoTurnWindows(thread: DemoThread): ReadonlyArray<DemoTurnWindow> {
  const count = thread.exchanges.length;
  const work = thread.workMinutes ?? 3;
  const gap = Math.max(EXCHANGE_GAP_MINUTES, work * 2);
  return thread.exchanges.map((_exchange, index) => {
    const answered = thread.minutesAgo + (count - 1 - index) * gap;
    const isOpenTurn = index === count - 1 && thread.state === "running";
    return isOpenTurn
      ? { startMinutes: answered, endMinutes: Math.min(0.2, answered / 10) }
      : { startMinutes: answered + work, endMinutes: answered };
  });
}

function seedThread(
  database: NodeSqlite.DatabaseSync,
  home: string,
  now: number,
  thread: DemoThread,
  checkpoints: ReadonlyArray<DemoCheckpointRecord | null>,
) {
  const project = DEMO_PROJECTS.find((candidate) => candidate.id === thread.projectId);
  if (!project) throw new Error(`${thread.id} references unknown project ${thread.projectId}.`);
  const count = thread.exchanges.length;
  const turnId = (index: number) => `${thread.id}-turn-${index + 1}`;
  const windows = demoTurnWindows(thread);
  const lastTurnId = turnId(count - 1);
  const isRunning = thread.state === "running";
  const lastAskedAt = at(now, windows[count - 1]!.startMinutes);
  const updatedAt = at(now, thread.minutesAgo);

  const insertMessage = database.prepare(
    `INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text,
      is_streaming, attachments_json, context_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
  );
  const insertTurn = database.prepare(
    `INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, assistant_message_id,
      state, requested_at, started_at, completed_at, checkpoint_turn_count, checkpoint_ref,
      checkpoint_status, checkpoint_files_json, source_proposed_plan_thread_id, source_proposed_plan_id)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  );
  thread.exchanges.forEach(([question, answer], index) => {
    const window = windows[index]!;
    const isLast = index === count - 1;
    const askedAt = at(now, window.startMinutes);
    const answeredAt = at(now, window.endMinutes);
    insertMessage.run(
      `${turnId(index)}-user`,
      thread.id,
      turnId(index),
      "user",
      question,
      0,
      askedAt,
      askedAt,
    );
    if (isLast && thread.reasoning) {
      // Reasoning streams while the turn runs; the ingestion stores it as its own message.
      const reasonedAt = at(
        now,
        window.startMinutes - (window.startMinutes - window.endMinutes) * 0.5,
      );
      insertMessage.run(
        `${turnId(index)}-reasoning`,
        thread.id,
        turnId(index),
        "reasoning",
        thread.reasoning,
        isRunning ? 1 : 0,
        at(now, window.startMinutes - 0.05),
        isRunning ? answeredAt : reasonedAt,
      );
    }
    if (answer !== null) {
      insertMessage.run(
        `${turnId(index)}-assistant`,
        thread.id,
        turnId(index),
        "assistant",
        answer,
        0,
        answeredAt,
        answeredAt,
      );
    }
    const checkpoint = checkpoints[index] ?? null;
    const state = isLast ? LATEST_TURN_STATE[thread.state] : "completed";
    insertTurn.run(
      thread.id,
      turnId(index),
      answer === null ? null : `${turnId(index)}-assistant`,
      state,
      askedAt,
      askedAt,
      state === "running" ? null : answeredAt,
      checkpoint?.turnCount ?? null,
      checkpoint?.ref ?? null,
      checkpoint ? "ready" : null,
      JSON.stringify(checkpoint?.files ?? []),
    );
  });

  const insertActivity = database.prepare(
    `INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind,
      summary, payload_json, sequence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  buildThreadActivities(thread, windows).forEach((activity, index) => {
    insertActivity.run(
      activity.id,
      thread.id,
      turnId(activity.turnIndex),
      activity.tone,
      activity.kind,
      activity.summary,
      JSON.stringify(activity.payload),
      index + 1,
      at(now, activity.minutesAgo),
    );
  });
  if (thread.approval) {
    database
      .prepare(
        `INSERT INTO projection_pending_approvals (request_id, thread_id, turn_id, status,
          decision, created_at, resolved_at) VALUES (?, ?, ?, 'pending', NULL, ?, NULL)`,
      )
      .run(demoRequestId(thread), thread.id, lastTurnId, updatedAt);
  }
  if (thread.plan) {
    database
      .prepare(
        `INSERT INTO projection_thread_proposed_plans (plan_id, thread_id, turn_id, plan_markdown,
          created_at, updated_at, implemented_at, implementation_thread_id)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(`${thread.id}-plan`, thread.id, lastTurnId, thread.plan, updatedAt, updatedAt);
  }

  const pr = thread.pullRequest;
  if (pr && project.remote) {
    const closedAt = pr.state === "open" ? null : updatedAt;
    database
      .prepare(
        `INSERT INTO projection_thread_pull_requests (thread_id, host, repository, number, url,
          source, linked_at, snapshot_json, stack_json) VALUES (?, ?, ?, ?, ?, 'created', ?, ?, NULL)`,
      )
      .run(
        thread.id,
        project.remote.host,
        project.remote.repository,
        pr.number,
        pullRequestUrl(project, pr.number),
        at(now, windows[0]!.endMinutes),
        JSON.stringify({
          state: pr.state,
          title: thread.title,
          headBranch: thread.branch ?? "main",
          baseBranch: "main",
          isDraft: pr.isDraft ?? false,
          updatedAt,
          syncedAt: updatedAt,
          closedAt,
          mergedAt: pr.state === "merged" ? closedAt : null,
          author: { login: "demo-user", name: "Demo User", avatarUrl: null },
          additions: pr.additions,
          deletions: pr.deletions,
          changedFiles: pr.changedFiles,
          reviewDecision: pr.review,
          checksState: pr.checks,
          mergeability: pr.state === "open" ? "mergeable" : "unknown",
        }),
      );
  }

  database
    .prepare(
      `INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json,
        runtime_mode, interaction_mode, branch, worktree_path, latest_turn_id,
        latest_user_message_at, pending_approval_count, pending_user_input_count,
        has_actionable_proposed_plan, created_at, updated_at, archived_at, deleted_at,
        settled_override, settled_at, snoozed_until, snoozed_at, pinned_at, pin_order_key)
       VALUES (?, ?, ?, ?, 'full-access', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      thread.id,
      thread.projectId,
      thread.title,
      JSON.stringify({
        instanceId: thread.provider,
        model: DEMO_MODEL_BY_PROVIDER[thread.provider],
      }),
      thread.plan ? "plan" : "default",
      thread.branch ?? null,
      thread.worktree ? demoPaths(home).worktree(thread) : null,
      lastTurnId,
      lastAskedAt,
      thread.approval ? 1 : 0,
      thread.question ? 1 : 0,
      thread.plan ? 1 : 0,
      at(now, windows[0]!.startMinutes + 2),
      updatedAt,
      thread.archived ? updatedAt : null,
      thread.settled ? "settled" : null,
      thread.settled ? updatedAt : null,
      thread.snoozeHours === undefined
        ? null
        : new Date(now + thread.snoozeHours * 3_600_000).toISOString(),
      thread.snoozeHours === undefined ? null : at(now, Math.max(1, thread.minutesAgo - 1)),
      thread.pinKey ? updatedAt : null,
      thread.pinKey ?? null,
    );
  database
    .prepare(
      `INSERT INTO projection_thread_sessions (thread_id, status, provider_name, provider_instance_id,
        provider_session_id, provider_thread_id, runtime_mode, active_turn_id, last_error, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, 'full-access', ?, ?, ?)`,
    )
    .run(
      thread.id,
      isRunning ? "running" : thread.state === "failed" ? "error" : "ready",
      thread.provider,
      thread.provider,
      isRunning ? lastTurnId : null,
      thread.state === "failed" ? (thread.error ?? "Turn failed") : null,
      updatedAt,
    );
}

export function seedDatabase(
  home: string,
  now: number,
  checkpoints: DemoCheckpointIndex = new Map(),
): void {
  const database = new NodeSqlite.DatabaseSync(demoPaths(home).dbPath, { timeout: 10_000 });
  try {
    database.exec("BEGIN IMMEDIATE");
    for (const table of SEEDED_TABLES) database.exec(`DELETE FROM ${table}`);
    const insertProject = database.prepare(
      `INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json,
        created_at, updated_at, deleted_at, default_model_selection_json, project_icon_json)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    );
    DEMO_PROJECTS.forEach((project, index) => {
      const latest = Math.min(
        ...DEMO_THREADS.filter((thread) => thread.projectId === project.id).map(
          (t) => t.minutesAgo,
        ),
      );
      insertProject.run(
        project.id,
        project.title,
        demoPaths(home).repoRoot(project),
        project.remote ? PROJECT_SCRIPTS : "[]",
        at(now, (120 - index * 10) * 24 * 60),
        at(now, latest),
        JSON.stringify({ kind: "emoji", emoji: project.emoji }),
      );
    });
    for (const thread of DEMO_THREADS) {
      seedThread(database, home, now, thread, checkpoints.get(thread.id) ?? []);
    }
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Nothing to roll back.
    }
    throw error;
  } finally {
    database.close();
  }
}

/**
 * Server boot marks sessions without a live provider as errored, so "running"
 * threads only survive when re-applied after startup. Reload the client after.
 */
export function markRunning(home: string, now: number): number {
  const database = new NodeSqlite.DatabaseSync(demoPaths(home).dbPath, { timeout: 10_000 });
  try {
    let marked = 0;
    for (const thread of DEMO_THREADS.filter((candidate) => candidate.state === "running")) {
      const turnId = `${thread.id}-turn-${thread.exchanges.length}`;
      const updatedAt = at(now, thread.minutesAgo);
      marked += Number(
        database
          .prepare(
            `UPDATE projection_thread_sessions SET status = 'running', active_turn_id = ?,
              last_error = NULL, updated_at = ? WHERE thread_id = ?`,
          )
          .run(turnId, updatedAt, thread.id).changes,
      );
      database
        .prepare(
          `UPDATE projection_turns SET state = 'running', completed_at = NULL
           WHERE thread_id = ? AND turn_id = ?`,
        )
        .run(thread.id, turnId);
    }
    return marked;
  } finally {
    database.close();
  }
}
