import { assert, it } from "@effect/vitest";

import { buildThreadActivities } from "./demo-activities.ts";
import { demoTurnWindows } from "./demo-database.ts";
import { DEMO_PROJECTS, DEMO_THREADS, type DemoThread } from "./demo-dataset.ts";

// Mirrors the prototype's title heuristic (apps/web/.../sections/threadKind.ts):
// a chat-looking title with a branch or worktree is shown as a Task instead.
const CHAT_TITLE = /^(how|why|what|which|when|where|who|can|could|should|is|are|does|do)\b|\?$/i;

it("files every demo project under the intended Home section", () => {
  for (const project of DEMO_PROJECTS) {
    // The sidebar places a project under Work › Northwind when its name or root contains "northwind".
    const placedInNorthwind = `${project.title} ${project.directory}`
      .toLowerCase()
      .includes("northwind");
    assert.strictEqual(placedInNorthwind, project.group === "northwind", project.id);
  }
});

it("keeps threads consistent with their projects", () => {
  const projectIds = new Set(DEMO_PROJECTS.map((project) => project.id));
  const threadIds = new Set(DEMO_THREADS.map((thread) => thread.id));
  assert.strictEqual(threadIds.size, DEMO_THREADS.length);
  for (const thread of DEMO_THREADS) {
    assert.isTrue(projectIds.has(thread.projectId), thread.id);
    assert.isTrue(thread.exchanges.length > 0, thread.id);
    // Only the latest turn may lack an answer: running, or cut off by an error or interrupt.
    const unanswered = thread.exchanges.flatMap(([, answer], index) =>
      answer === null ? [index] : [],
    );
    const lastIndex = thread.exchanges.length - 1;
    if (thread.state === "running") assert.deepStrictEqual(unanswered, [lastIndex], thread.id);
    else if (thread.state === "failed" || thread.state === "interrupted") {
      assert.isTrue(
        unanswered.every((index) => index === lastIndex),
        thread.id,
      );
    } else assert.deepStrictEqual(unanswered, [], thread.id);
    assert.strictEqual(thread.error !== undefined, thread.state === "failed", thread.id);
    assert.strictEqual(thread.approval !== undefined, thread.state === "approval", thread.id);
    assert.strictEqual(thread.question !== undefined, thread.state === "input", thread.id);
    if (thread.worktree) assert.isDefined(thread.branch, thread.id);
    if (thread.pullRequest) {
      assert.isDefined(thread.branch, thread.id);
      const project = DEMO_PROJECTS.find((candidate) => candidate.id === thread.projectId);
      assert.isNotNull(project?.remote ?? null, thread.id);
    }
  }
});

it("shows both chats and tasks, with chats kept off branches", () => {
  const chats = DEMO_THREADS.filter((thread) => CHAT_TITLE.test(thread.title.trim()));
  assert.isTrue(chats.length >= 5);
  assert.isTrue(DEMO_THREADS.length - chats.length >= 10);
  for (const chat of chats) assert.isUndefined(chat.branch, chat.id);
});

it("covers every sidebar state with valid pin keys", () => {
  const has = (predicate: (thread: (typeof DEMO_THREADS)[number]) => boolean) =>
    DEMO_THREADS.some(predicate);
  for (const state of [
    "running",
    "approval",
    "input",
    "plan",
    "failed",
    "interrupted",
    "done",
  ] as const) {
    assert.isTrue(
      has((thread) => thread.state === state),
      state,
    );
  }
  assert.isTrue(has((thread) => thread.settled === true));
  assert.isTrue(has((thread) => thread.snoozeHours !== undefined));
  assert.isTrue(has((thread) => thread.archived === true));
  assert.isTrue(has((thread) => thread.pullRequest?.state === "merged"));
  assert.isTrue(has((thread) => thread.pullRequest?.state === "open"));
  assert.strictEqual(new Set(DEMO_THREADS.map((thread) => thread.provider)).size, 5);

  const pinKeys = DEMO_THREADS.flatMap((thread) => (thread.pinKey ? [thread.pinKey] : []));
  assert.isTrue(pinKeys.length >= 2);
  assert.strictEqual(new Set(pinKeys).size, pinKeys.length);
  // Pin order keys are base-26 fractional indexes that never end in the minimum digit.
  for (const key of pinKeys) assert.match(key, /^[a-z]*[b-z]$/);
});

const has = (predicate: (thread: DemoThread) => boolean) => DEMO_THREADS.some(predicate);
const agentStatuses = (thread: DemoThread) => new Set(thread.subagents?.map((a) => a.status));

it("covers the thread surfaces the chat, Agents, and Diff panels render", () => {
  // A running Claude fleet mid-flight: working, finished, and failed agents together.
  assert.isTrue(
    has((thread) => {
      const statuses = agentStatuses(thread);
      return (
        thread.state === "running" &&
        thread.provider === "claudeAgent" &&
        statuses.has("running") &&
        statuses.has("completed") &&
        statuses.has("failed")
      );
    }),
  );
  // A settled turn whose agents all finished with summaries.
  assert.isTrue(
    has(
      (thread) =>
        thread.state === "done" &&
        thread.workflow === undefined &&
        (thread.subagents?.length ?? 0) >= 2 &&
        thread.subagents!.every((agent) => agent.status === "completed" && agent.result),
    ),
  );
  // Codex children settle as idle (resumable), never "completed".
  assert.isTrue(has((thread) => thread.provider === "codex" && agentStatuses(thread).has("idle")));
  for (const thread of DEMO_THREADS.filter((candidate) => candidate.provider === "codex")) {
    assert.isFalse(agentStatuses(thread).has("completed"), thread.id);
  }
  assert.isTrue(has((thread) => thread.workflow !== undefined));
  assert.isTrue(has((thread) => thread.approvalKind === "file-change"));
  assert.isTrue(
    has((thread) => thread.approval !== undefined && thread.approvalKind !== "file-change"),
  );
  assert.isTrue(has((thread) => thread.state === "running" && thread.reasoning !== undefined));
  assert.isTrue(has((thread) => (thread.todos?.length ?? 0) > 0));
  assert.isTrue(has((thread) => thread.compaction !== undefined));
  assert.isTrue(
    has(
      (thread) =>
        (thread.context ? thread.context.usedTokens / thread.context.maxTokens : 0) > 0.85,
    ),
  );
  assert.isTrue(
    has(
      (thread) => thread.worktree === true && thread.exchanges.length > 1 && !!thread.checkpoints,
    ),
  );
  for (const provider of ["codex", "claudeAgent"] as const) {
    assert.isTrue(
      has((thread) => thread.provider === provider && !!thread.subagents),
      provider,
    );
  }
});

it("keeps subagent, workflow, and compaction data coherent", () => {
  for (const thread of DEMO_THREADS) {
    const agents = thread.subagents ?? [];
    assert.strictEqual(new Set(agents.map((agent) => agent.id)).size, agents.length, thread.id);
    for (const agent of agents) {
      if (agent.status === "failed") assert.isDefined(agent.error, agent.id);
      if (agent.status === "completed") assert.isDefined(agent.result, agent.id);
      if (agent.status === "running") assert.strictEqual(thread.state, "running", agent.id);
      const inWorkflow = agent.phase !== undefined;
      assert.strictEqual(inWorkflow, thread.workflow !== undefined, agent.id);
      if (inWorkflow) assert.isTrue(agent.phase! < thread.workflow!.phases.length, agent.id);
    }
    if (thread.compaction) {
      assert.isTrue(thread.compaction.turn < thread.exchanges.length, thread.id);
      assert.isTrue(thread.compaction.afterTokens < thread.compaction.beforeTokens, thread.id);
    }
    if (thread.checkpoints) {
      assert.isTrue(thread.checkpoints.length <= thread.exchanges.length, thread.id);
    }
  }
});

it("builds unique, chronological activities inside each turn", () => {
  const ids = new Set<string>();
  for (const thread of DEMO_THREADS) {
    const windows = demoTurnWindows(thread);
    const activities = buildThreadActivities(thread, windows);
    let previous = Number.POSITIVE_INFINITY;
    for (const activity of activities) {
      // activity_id is the projection table's primary key across all threads.
      assert.isFalse(ids.has(activity.id), activity.id);
      ids.add(activity.id);
      assert.isTrue(activity.minutesAgo <= previous, activity.id);
      previous = activity.minutesAgo;
      const window = windows[activity.turnIndex]!;
      assert.isTrue(activity.minutesAgo <= window.startMinutes, activity.id);
      assert.isTrue(activity.minutesAgo >= window.endMinutes, activity.id);
    }
    // Every agent row carries the ingestion stamp the Agents panel filters on.
    const agentRows = activities.filter((activity) => activity.kind.startsWith("task."));
    for (const row of agentRows) assert.strictEqual(row.payload.agentKind, "agent", row.id);
    const started = agentRows.filter((row) => row.kind === "task.started").length;
    assert.strictEqual(
      started,
      (thread.subagents?.length ?? 0) + (thread.workflow ? 1 : 0),
      thread.id,
    );
    const terminal = activities.filter(
      (row) =>
        row.kind === "task.completed" ||
        (row.kind === "task.updated" && row.payload.status !== "running"),
    ).length;
    const settledAgents = (thread.subagents ?? []).filter((agent) => agent.status !== "running");
    const workflowDone =
      thread.workflow && settledAgents.length === thread.subagents?.length ? 1 : 0;
    assert.strictEqual(terminal, settledAgents.length + workflowDone, thread.id);
  }
});

it("keeps the public demo free of real machine paths and addresses", () => {
  const text = JSON.stringify([DEMO_PROJECTS, DEMO_THREADS]);
  assert.notMatch(text, /\/Users\/|\/home\/[a-z]/);
  const emails = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? [];
  for (const email of emails) assert.match(email, /\.invalid$|@example\.com$/, email);
});
