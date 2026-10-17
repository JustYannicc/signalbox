/**
 * Interprets a task's one-click early settle. Automatic completion has already
 * recorded its outcome, so only an unsettled task record needs the assistant.
 */
export const SETTLE_TASK = `export const meta = {
  name: "Settle task",
  description: "Records why a task was settled early, starts a narrow finishing pass when it is done enough, and asks quietly when the reason is unclear.",
  intent: "when a task is settled early, record why, and finish only when it is done enough",
  triggers: [{ on: "thread.settled" }],
} as const;

type Reason = "dropped" | "done-enough";
type Thread = {
  id: string;
  title: string;
  settledAt: string | null;
  settledOverride: "settled" | "active" | null;
  archivedAt: string | null;
};
type TaskRecord = {
  generation: number;
  outcome: string | null;
  condition: { summary: string } | null;
};
type Lifecycle = {
  kind: "chat" | "task";
  thread: Thread;
  messages: Array<{ id?: string; role: string; text: string }>;
  runs: Array<{ id: string; status: string }>;
  record: TaskRecord | null;
  applied: boolean;
};
type Guess = { reason: Reason; outcome: string; uncertain: boolean; finishing: string };

const UNCLEAR_OUTCOME = "Task settled; the reason was unclear.";

function isSettled(thread: Thread) {
  return thread.archivedAt !== null || thread.settledAt !== null || thread.settledOverride === "settled";
}

function parseGuess(answer: string): Guess {
  try {
    const parsed = JSON.parse(answer) as Record<string, unknown>;
    const reason = parsed.reason === "dropped" || parsed.reason === "done-enough"
      ? parsed.reason
      : "done-enough";
    const rawOutcome = typeof parsed.outcome === "string" ? parsed.outcome.trim() : "";
    const finishing = typeof parsed.finishing === "string" ? parsed.finishing.trim() : "";
    const uncertain = typeof parsed.uncertain === "boolean" ? parsed.uncertain : true;
    const outcome = rawOutcome
      ? rawOutcome.split("\\n").join(" ").split("\\r").join(" ").slice(0, 400)
      : UNCLEAR_OUTCOME;
    return {
      reason,
      outcome,
      finishing: finishing.slice(0, 1200),
      uncertain:
        reason !== parsed.reason || !rawOutcome || typeof parsed.finishing !== "string" || uncertain,
    };
  } catch {
    return { reason: "done-enough", outcome: UNCLEAR_OUTCOME, finishing: "", uncertain: true };
  }
}

export default workflow(async (w, input: { threadId?: string }) => {
  const threadId = input.threadId;
  if (!threadId) return "No thread was attached to this settle event.";

  const before: Lifecycle = await w.call("Read the task that settled", "signalbox.task_lifecycle", {
    threadId,
    action: "read",
    includeContext: true,
  });
  // A model step's own thread settles when the step ends; reading it here would start another step.
  if (before.messages.find((message) => message.role === "user")?.id?.startsWith("automation:"))
    return "The parent automation owns this helper thread.";
  if (before.kind !== "task" || !isSettled(before.thread)) return "This is not a settled task.";
  if (before.record && before.record.outcome !== null) return "The task already has an outcome.";
  const expectedGeneration = before.record?.generation ?? 0;

  const answer = await w.llm("Understand why the task was settled", {
    prompt: [
      "You are the person's assistant. Read this task and infer why the person settled it early.",
      'Return only JSON with reason exactly "dropped" or "done-enough", outcome as one line, uncertain as a boolean, and finishing as a short note for a folder agent.',
      'Use "dropped" only when the work is no longer needed. Use "done-enough" when the useful work is complete but cleanup, tests, docs, or hardening remain.',
      "Set uncertain true whenever the conversation does not make the reason clear. Do not use a classifier that cannot read the conversation.",
      "If the reason is unclear, still give your best provisional reason. The task stays settled while its low-priority question waits for an answer.",
    ].join("\\n\\n"),
    input: {
      thread: before.thread,
      doneCondition: before.record?.condition,
      messages: before.messages,
      runs: before.runs,
    },
  });
  const guess = parseGuess(answer);

  // A new message can reopen the thread while the model is reading it.
  const current: Lifecycle = await w.call("Recheck the task state", "signalbox.task_lifecycle", {
    threadId,
    action: "read",
  });
  if (
    current.kind !== "task" ||
    !isSettled(current.thread) ||
    (current.record?.generation ?? 0) !== expectedGeneration ||
    (current.record !== null && current.record.outcome !== null)
  ) return "The task changed while I was reading it.";

  const recorded: Lifecycle = await w.call("Record the settle reason", "signalbox.task_lifecycle", {
    threadId,
    action: "record-settle",
    reason: guess.reason,
    outcome: guess.outcome,
    uncertain: guess.uncertain,
    expectedGeneration,
  });
  if (!recorded.applied || !recorded.record) return "The task changed before I could record the reason.";

  let reason = guess.reason;
  let settledRecord = recorded.record;
  if (guess.uncertain) {
    const answer = await w.ask("Why did you settle this task?", {
      question: [
        \`I guessed "\${guess.reason}": \${guess.outcome}\`,
        "Which reason fits? The task stays settled while this waits.",
      ].join("\\n\\n"),
      options: ["dropped", "done-enough"],
      importance: "low",
    });
    reason = answer === "dropped" ? "dropped" : "done-enough";
    const correction: Lifecycle = await w.call("Record your answer", "signalbox.task_lifecycle", {
      threadId,
      action: "record-settle",
      reason,
      outcome: guess.outcome,
      uncertain: false,
      expectedGeneration: settledRecord.generation,
    });
    if (!correction.applied || !correction.record) return "The task changed before I could record your answer.";
    settledRecord = correction.record;
  }

  if (reason === "dropped") return { reason, outcome: guess.outcome, finishing: "skipped" };

  const latest: Lifecycle = await w.call("Confirm the task is still settled", "signalbox.task_lifecycle", {
    threadId,
    action: "read",
  });
  if (
    latest.kind !== "task" ||
    !isSettled(latest.thread) ||
    latest.record === null ||
    latest.record?.generation !== settledRecord.generation ||
    latest.record.outcome === null
  ) return "The task reopened before the finishing pass started.";

  const finished = await w.agent("Pave behind the settled task", {
    prompt: [
      "You are this folder's finishing agent. You represent this project folder, not the user. Work in this folder's project and use the supplied task as your scope.",
      "Make a narrow finishing pass on work that is already useful: cleanup, tests, docs, and hardening. Do not expand the task or reopen it.",
      "Before changing files, read the task lifecycle. If this task is no longer settled with the recorded outcome, stop without changing anything.",
      \`Task thread: \${threadId} (\${before.thread.title}).\`,
      \`Done condition: \${before.record?.condition?.summary ?? "none recorded"}.\`,
      \`Recorded outcome: \${guess.outcome}.\`,
      \`Finishing context: \${guess.finishing || "Read the task conversation and decide whether a small finishing pass is warranted."}\`,
    ].join("\\n\\n"),
  });
  return { reason, outcome: guess.outcome, finishing: finished.threadId };
});
`;
