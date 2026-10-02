/**
 * Multiplayer items: chats, tasks and rooms that are Shared (the team sees them
 * and can reply) or Private (only the owner and people added). Kind and
 * visibility are independent; visibility starts from the container's default
 * (`defaultScopeFor` in `sharing.ts`). UI prototype; everything lives in
 * `multiplayerFixtures.ts` until teams are real.
 */

export type AvatarGradient = "sky" | "mint" | "amber" | "rose";

export interface TeamPerson {
  readonly id: string;
  readonly name: string;
  readonly gradient: AvatarGradient;
  readonly email: string;
  readonly role: "Owner" | "Admin" | "Member" | "Guest";
  readonly title: string;
  /** The assistant that represents this person to others. Yours comes from settings. */
  readonly assistantName: string;
}

export interface Team {
  readonly id: string;
  readonly name: string;
  readonly memberIds: readonly string[];
}

export type ThreadVisibility = "shared" | "private";

export interface TeamProject {
  readonly id: string;
  /** Repository-style name, e.g. "merchant-portal". */
  readonly name: string;
  readonly teamId: string;
  /** The Home section the project sits in. */
  readonly sectionId: string;
  /** People working in the project right now. */
  readonly activeIds: readonly string[];
  /** What the project preconfigures for anyone who continues it. */
  readonly setup: ProjectSetup;
}

export interface ProjectSetup {
  readonly skills: number;
  /** Team-owned connections, e.g. "Executor · Northwind Google". */
  readonly connections: readonly string[];
  readonly instructions: string;
  /** Accounts each person connects themselves; never shared. */
  readonly personalAccounts: readonly string[];
}

export interface TeamThread {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly kind: "chat" | "task";
  /** What the fixture starts as; the user's change lives in the visibility store. */
  readonly visibility: ThreadVisibility;
  /** Who has posted, owner first. Private threads only ever hold the owner. */
  readonly participantIds: readonly string[];
  readonly lastActiveAt: string;
  /** Static presence for the mock: this person "is typing". */
  readonly typingId?: string;
  /** Static presence for the mock: people on this item right now (besides you). */
  readonly presentIds?: readonly string[];
  /** Set when the thread began as a Chat and switched to Task once it started real work. */
  readonly switchedToTaskAt?: string;
  /** When the agent answers; defaults to each message. */
  readonly replyMode?: ReplyMode;
  /** Fixture: the agent is holding its answer until these people reply. */
  readonly waitingForIds?: readonly string[];
}

/**
 * `each`: the agent answers every message right away, like a normal AI chat.
 * `everyone`: it holds its reply until everyone taking part has posted.
 */
export type ReplyMode = "each" | "everyone";

/** Which harness and model answered, e.g. Codex · GPT-5.4. */
export interface HarnessRef {
  readonly provider: "codex" | "claudeAgent" | "cursor" | "opencode" | "grok";
  readonly model: string;
}

export type MessageAuthor =
  | { readonly kind: "person"; readonly personId: string }
  /** The thread's agent, answering `startedById`'s message. */
  | {
      readonly kind: "agent";
      readonly name: string;
      readonly startedById: string;
      readonly harness?: HarnessRef;
    }
  /** A centered timeline event: model or harness switches, shares, kind changes. */
  | { readonly kind: "system"; readonly event: SystemEvent };

/** Model or harness switch, share, Chat/Task change, reply-mode change, a hold, or who was notified. */
export type SystemEvent = "model" | "share" | "kind" | "mode" | "waiting" | "notify";

/** One step of an agent's work, shaped like a real work-log row. */
export interface WorkStep {
  readonly label: string;
  readonly itemType?: "command_execution" | "file_change" | "web_search" | "mcp_tool_call";
  readonly command?: string;
  readonly detail?: string;
  readonly changedFiles?: readonly string[];
  readonly failed?: boolean;
  /** Still running (live turns only). */
  readonly running?: boolean;
}

export interface TeamMessage {
  readonly id: string;
  readonly author: MessageAuthor;
  readonly body: string;
  /** Display time, e.g. "10:42". */
  readonly at: string;
  /** Exact time, for messages sent from this device. */
  readonly createdAt?: string;
  /** Attached file names, shown as chips. */
  readonly files?: readonly string[];
  /** Agent turns: the work before the answer (tool calls, edits, searches). */
  readonly work?: readonly WorkStep[];
  /** Agent turns: a proposed plan, rendered as the real plan card. */
  readonly plan?: string;
  /**
   * The last agent turn, caught mid-work: reasoning streams (`thinking`), a
   * tool runs (`working`), or the answer streams in (`answering`).
   */
  readonly live?: "thinking" | "working" | "answering";
  /** Live turns: the reasoning so far. */
  readonly reasoning?: string;
  /** Live turns: an approval the agent is waiting on, from whoever started it. */
  readonly approval?: { readonly kind: "command" | "file-change"; readonly detail: string };
}

export function personInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "";
  return `${first}${last}`.toUpperCase();
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

export interface SharedThreadSearch {
  /** Container a new draft starts in: team project or Home section id (`?project=`). */
  readonly project?: string;
  /** `?kind=task`: what a new draft is. Never implies visibility. */
  readonly kind?: TeamThread["kind"];
  /** `?prompt=`: prefills the composer, then leaves the URL. */
  readonly prompt?: string;
  /** `?share=flynn,northwind` or `private`: a new draft's starting access, then leaves the URL. */
  readonly share?: string;
}

const MAX_PROMPT_PARAM = 8000;

export function validateSharedThreadSearch(raw: Record<string, unknown>): SharedThreadSearch {
  const project = typeof raw.project === "string" && raw.project.length > 0 ? raw.project : null;
  const kind = raw.kind === "chat" || raw.kind === "task" ? raw.kind : null;
  const prompt =
    typeof raw.prompt === "string" && raw.prompt.trim().length > 0
      ? raw.prompt.slice(0, MAX_PROMPT_PARAM)
      : null;
  const share = typeof raw.share === "string" && raw.share.trim().length > 0 ? raw.share : null;
  return {
    ...(project ? { project } : {}),
    ...(kind ? { kind } : {}),
    ...(prompt ? { prompt } : {}),
    ...(share ? { share } : {}),
  };
}

/**
 * Legacy draft ids. Visiting one opens a fresh unique draft instead
 * (`newDraftThreadId`); the visibility in the name is ignored.
 */
export const NEW_THREAD_IDS: Record<ThreadVisibility, string> = {
  private: "new-private",
  shared: "new-shared",
};

/** Legacy kind-named draft ids; also redirected to a fresh draft. */
export const NEW_ITEM_IDS: Record<TeamThread["kind"], string> = {
  chat: "new-chat",
  task: "new-task",
};

const DRAFT_PREFIX = "draft-";

/** A short random id suffix for local-only items; not cryptographic. */
export function shortId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * A fresh id for each new chat or task, so drafts never share state. Open it
 * as `/shared/<id>?project=<container>&kind=chat|task`; visibility follows
 * the container's default.
 */
export function newDraftThreadId(): string {
  return `${DRAFT_PREFIX}${shortId()}`;
}

export function isDraftThreadId(threadId: string): boolean {
  return threadId.startsWith(DRAFT_PREFIX);
}

export function isLegacyDraftThreadId(threadId: string): boolean {
  return (
    Object.values(NEW_THREAD_IDS).includes(threadId) ||
    Object.values(NEW_ITEM_IDS).includes(threadId)
  );
}
