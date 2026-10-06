/**
 * The events an automation can trigger on with `{ on: … }`. One table drives
 * the server's normalizer (it must build every name here), the compiler's
 * checks, the agent reference, and the words clients show.
 *
 * Every event arrives as an envelope: `{ event, id, at, projectId, threadId?,
 * runId?, …fields }`. `id` is stable per occurrence, so it doubles as the
 * dedupe key. Besides these names, every internal orchestration event passes
 * through raw as `orchestration.<type>` with its payload under `data`.
 */

export interface AutomationEventSpec {
  readonly name: string;
  /** How a trigger on it reads in clients: "When a turn finishes". */
  readonly when: string;
  readonly description: string;
  /** The event's own fields, on top of the envelope. */
  readonly fields: Readonly<Record<string, string>>;
  /** The trigger's `from` (people, agents, anyone) filters who caused it. */
  readonly from?: true;
}

const THREAD = { threadTitle: "the thread's title" } as const;
const AUTOMATION = {
  automationId: "the automation's id",
  automationName: "its meta.name",
  automationRunId: "the run's id",
} as const;

export const AUTOMATION_EVENTS = [
  {
    name: "thread.created",
    when: "When a thread starts",
    description: "A thread was created.",
    fields: {
      title: "its title",
      provider: "provider instance, e.g. codex",
      model: "model id",
      createdBy: "person | agent | system",
      branch: "git branch or null",
      worktreePath: "worktree path or null",
      parentThreadId: "the thread it was forked or delegated from, or null",
    },
    from: true,
  },
  {
    name: "thread.updated",
    when: "When a thread is renamed or moves branch",
    description: "A thread's title, branch or worktree changed.",
    fields: { title: "", branch: "", worktreePath: "" },
  },
  ...(
    [
      ["thread.archived", "When a thread is archived"],
      ["thread.unarchived", "When a thread is unarchived"],
      ["thread.deleted", "When a thread is deleted"],
      ["thread.settled", "When a thread is settled"],
      ["thread.unsettled", "When a thread comes back"],
      ["thread.snoozed", "When a thread is snoozed"],
      ["thread.unsnoozed", "When a thread wakes up"],
      ["thread.pinned", "When a thread is pinned"],
      ["thread.unpinned", "When a thread is unpinned"],
    ] as const
  ).map(([name, when]) => ({
    name,
    when,
    description: `${when.replace("When a", "A")}.`,
    fields: { title: "the thread's title" },
  })),
  {
    name: "thread.model-changed",
    when: "When a thread switches model",
    description: "A thread's provider or model changed.",
    fields: { title: "", provider: "", model: "" },
  },
  {
    name: "thread.mode-changed",
    when: "When a thread's mode changes",
    description: "A thread's runtime or interaction mode changed.",
    fields: { title: "", runtimeMode: "", interactionMode: "" },
  },
  {
    name: "pr.updated",
    when: "When a thread's pull requests change",
    description: "Pull requests linked to a thread were synced: linked, opened, merged, closed.",
    fields: {
      ...THREAD,
      pullRequests: "[{ repository, number, url, source }]",
      branchPullRequest: "{ repository, number, url } found from the branch, or null",
    },
  },
  {
    name: "turn.requested",
    when: "When a turn is queued",
    description: "A message started a new turn (it may wait behind another).",
    fields: { ...THREAD, status: "", userMessageId: "the message that started it" },
  },
  {
    name: "turn.started",
    when: "When a turn starts",
    description: "A turn began running.",
    fields: { ...THREAD, provider: "", model: "", startedAt: "" },
  },
  {
    name: "turn.finished",
    when: "When a turn finishes",
    description: "A turn ended, however it ended.",
    fields: {
      ...THREAD,
      status: "completed | failed | interrupted | cancelled",
      provider: "",
      model: "",
      lastMessage: "the agent's final text (up to 20k chars)",
      error: "why it failed, or null",
      branch: "",
      worktreePath: "",
      startedAt: "",
      finishedAt: "",
    },
  },
  {
    name: "message.sent",
    when: "When a message is sent",
    description: "A message was sent into a thread (not the agent's own replies).",
    fields: {
      ...THREAD,
      messageId: "",
      text: "the message (up to 20k chars)",
      author: "person | agent | system",
      attachments: "how many files came with it",
    },
    from: true,
  },
  {
    name: "agent.replied",
    when: "When an agent replies",
    description: "An agent finished writing a message.",
    fields: { ...THREAD, messageId: "", text: "the reply (up to 20k chars)" },
  },
  {
    name: "input.requested",
    when: "When an agent needs you",
    description: "An agent is waiting on a person: an approval, a question, or a sign-in.",
    fields: {
      ...THREAD,
      requestId: "",
      kind: "approval | question | sign-in | tool",
      request: "command | file-read | file-change | mcp-elicitation | permission | user_input | …",
      summary: "what it asks, when the agent said",
    },
  },
  {
    name: "input.resolved",
    when: "When a request is answered",
    description: "A pending approval or question was answered, expired or was cancelled.",
    fields: {
      ...THREAD,
      requestId: "",
      request: "",
      status: "resolved | expired | cancelled",
      decision: "the approval decision, or null",
    },
  },
  {
    name: "approval.requested",
    when: "When an agent asks for approval",
    description: "An agent asked to run a command, change files, or use a tool.",
    fields: {
      ...THREAD,
      requestId: "",
      request: "command | file-read | file-change | mcp-elicitation | permission",
      prompt: "what it wants to do, or null",
      appName: "the app asking, for MCP elicitations, or null",
    },
  },
  {
    name: "question.asked",
    when: "When an agent asks a question",
    description: "An agent asked the person a question with options.",
    fields: { ...THREAD, requestId: "", questions: "the questions' text" },
  },
  {
    name: "tool.started",
    when: "When an agent starts a tool",
    description: "An agent started a command, search or tool call.",
    fields: {
      ...THREAD,
      itemId: "",
      tool: "command | file_search | web_search | <tool name>",
      title: "",
      input: "",
    },
  },
  {
    name: "tool.called",
    when: "When an agent uses a tool",
    description: "A command, search or tool call finished.",
    fields: {
      ...THREAD,
      itemId: "",
      tool: "command | file_search | web_search | <tool name>",
      title: "",
      status: "completed | failed | cancelled | interrupted",
      input: "the command or tool input (up to 4k chars)",
      output: "its output (up to 4k chars), or null",
      exitCode: "commands only, or null",
      failed: "true when it failed",
    },
  },
  {
    name: "file.changed",
    when: "When an agent changes a file",
    description: "An agent finished editing a file.",
    fields: {
      ...THREAD,
      itemId: "",
      fileName: "",
      paths: "every path it touched",
      additions: "",
      deletions: "",
    },
  },
  {
    name: "plan.proposed",
    when: "When an agent proposes a plan",
    description: "An agent finished writing a plan.",
    fields: { ...THREAD, planId: "", markdown: "the plan (up to 20k chars)" },
  },
  {
    name: "todos.updated",
    when: "When an agent's to-do list changes",
    description: "An agent updated its to-do list.",
    fields: { ...THREAD, steps: "[{ text, status }]", explanation: "" },
  },
  {
    name: "agent.error",
    when: "When an agent hits an error",
    description: "The provider reported an error in a turn.",
    fields: { ...THREAD, message: "", class: "the kind of failure", retryable: "" },
  },
  {
    name: "context.compacted",
    when: "When a thread's context is compacted",
    description: "A provider compacted the conversation.",
    fields: { ...THREAD, summary: "", beforeTokenCount: "", afterTokenCount: "" },
  },
  {
    name: "subagent.started",
    when: "When a subagent starts",
    description: "An agent started a subagent or delegated task.",
    fields: {
      ...THREAD,
      subagentId: "",
      origin: "provider_native | app_owned (delegated task)",
      title: "",
      prompt: "(up to 4k chars)",
      model: "",
      childThreadId: "its own thread, or null",
    },
  },
  {
    name: "subagent.finished",
    when: "When a subagent finishes",
    description: "A subagent or delegated task ended.",
    fields: {
      ...THREAD,
      subagentId: "",
      origin: "",
      title: "",
      status: "completed | failed | cancelled | interrupted",
      result: "(up to 20k chars), or null",
      childThreadId: "",
    },
  },
  {
    name: "checkpoint.captured",
    when: "When a checkpoint is saved",
    description: "A turn's changes were checkpointed.",
    fields: {
      ...THREAD,
      checkpointId: "",
      status: "",
      files: "[{ path, kind, additions, deletions }]",
    },
  },
  {
    name: "checkpoint.restore-requested",
    when: "When a checkpoint is restored",
    description: "Someone asked to roll a thread back to a checkpoint.",
    fields: { ...THREAD, checkpointId: "" },
  },
  {
    name: "automation.run.started",
    when: "When an automation starts",
    description: "An automation run started.",
    fields: { ...AUTOMATION, trigger: "manual | cron | webhook | automation | event" },
  },
  {
    name: "automation.run.succeeded",
    when: "When an automation succeeds",
    description: "An automation run finished.",
    fields: { ...AUTOMATION, title: "what it did, or null" },
  },
  {
    name: "automation.run.failed",
    when: "When an automation fails",
    description: "An automation run failed.",
    fields: { ...AUTOMATION, error: "" },
  },
  {
    name: "automation.run.cancelled",
    when: "When an automation is cancelled",
    description: "An automation run was cancelled.",
    fields: { ...AUTOMATION },
  },
  {
    name: "automation.step.failed",
    when: "When an automation step fails",
    description: "A step failed (the run may still catch it).",
    fields: { ...AUTOMATION, stepKey: "", verb: "", label: "", error: "" },
  },
  {
    name: "automation.ask.waiting",
    when: "When an automation asks you",
    description: "An ask step is waiting on a person.",
    fields: { ...AUTOMATION, stepKey: "", label: "", question: "or null" },
  },
] as const satisfies ReadonlyArray<AutomationEventSpec>;

export type AutomationEventName = (typeof AUTOMATION_EVENTS)[number]["name"];

/** Every internal orchestration event also arrives raw as `orchestration.<type>`, payload under `data`. */
export const AUTOMATION_RAW_EVENT_PREFIX = "orchestration.";

/** Fields every event carries. `threadId`/`runId` are there when the event belongs to a thread or turn. */
export const AUTOMATION_EVENT_ENVELOPE = {
  event: "the event's name",
  id: "stable per occurrence",
  at: "when it happened (ISO)",
  projectId: "the project it happened in",
  threadId: "the thread, when there is one",
  runId: "the turn, when there is one",
} as const;

const SPECS = new Map<string, AutomationEventSpec>(
  AUTOMATION_EVENTS.map((spec) => [spec.name, spec]),
);

export function automationEventSpec(name: string): AutomationEventSpec | undefined {
  return SPECS.get(name);
}

/**
 * Whether `pattern` matches `name`. `*` matches every catalog event (raw
 * `orchestration.*` events have to be named), `prefix.*` matches names under
 * that prefix at any depth, anything else must be equal.
 */
export function automationEventMatches(pattern: string, name: string): boolean {
  if (pattern === "*") return !name.startsWith(AUTOMATION_RAW_EVENT_PREFIX);
  if (pattern.endsWith(".*")) return name.startsWith(pattern.slice(0, -1));
  return pattern === name;
}

/** Whether `pattern` can ever match: a catalog name, a wildcard over some, or a raw orchestration event. */
export function isAutomationEventPattern(pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith(AUTOMATION_RAW_EVENT_PREFIX))
    return pattern.length > AUTOMATION_RAW_EVENT_PREFIX.length;
  if (pattern.endsWith(".*"))
    return AUTOMATION_EVENTS.some((spec) => automationEventMatches(pattern, spec.name));
  return SPECS.has(pattern);
}
