/**
 * PLACEHOLDER DATA for section and project agent pages. Supervisor agents are
 * personal: each user has their own, seeing their private chats plus what is
 * shared with them. The assistant hands work straight to the agent that owns
 * it; parent section agents watch their containers instead of relaying. Each
 * agent keeps one running chat that closes once all of its work is done;
 * earlier chats stay in History. Unknown ids resolve to a generic, empty agent.
 */
import * as Schema from "effect/Schema";

import { notificationTurn, type ChatFixture, type TurnFixture } from "./assistantFixtures";
import { workflowAgent } from "./workflowAgents";

export interface AgentChatFixture extends ChatFixture {
  readonly id: string;
  /** "Since Tue 29 Sep", "15 – 26 Sep". */
  readonly title: string;
  /** One-line summary for History, e.g. "3 handoffs, all done". */
  readonly meta: string;
}

export interface AgentFixture {
  readonly id: string;
  readonly kind: "section" | "project" | "workflow";
  /** What the agent can see into, e.g. "Work › Northwind team"; defaults to `name`. */
  readonly area?: string;
  /** Set for workflow agents: the automation they run. */
  readonly automationId?: string;
  /** Trace node the agent speaks as. */
  readonly nodeId: string;
  readonly name: string;
  readonly scope: string;
  readonly current: AgentChatFixture;
  readonly previous: readonly AgentChatFixture[];
}

const turn = (
  id: string,
  role: TurnFixture["role"],
  at: string,
  text: string,
  extra: { from?: string; delegationId?: string } = {},
): TurnFixture => ({
  id,
  role,
  at,
  ...(extra.from ? { from: extra.from } : {}),
  blocks: [
    { kind: "text", text },
    ...(extra.delegationId
      ? [{ kind: "delegation" as const, delegationId: extra.delegationId }]
      : []),
  ],
});

const chat = (
  id: string,
  title: string,
  meta: string,
  turns: readonly TurnFixture[],
): AgentChatFixture => ({ id, title, meta, carriedOver: [], turns });

export const AGENTS: readonly AgentFixture[] = [
  {
    id: "section-work",
    kind: "section",
    nodeId: "section:work",
    name: "Work",
    scope: "Work › Northwind team",
    current: chat("work-2", "Since Mon 28 Sep", "2 open", [
      turn(
        "w1",
        "assistant",
        "Mon 14:31",
        "Watching: the Neptune signing question is with the terminal-app agent. It's waiting on Flynn.",
        { delegationId: "d-neptune-questions" },
      ),
      turn(
        "w2",
        "assistant",
        "Tue 16:21",
        "Watching: the A920 printer fix went straight to the terminal-app agent.",
        { delegationId: "d-printer-fix" },
      ),
      notificationTurn("w2n", "Wed 06:30", {
        delivery: "none",
        reason: "CI red, already on your list",
        nodeId: "thread:printer-fix",
        detail: "The failure is already carried over in your assistant chat.",
      }),
      turn("w3", "user", "11:40", "anything in work that needs me today?"),
      turn(
        "w4",
        "assistant",
        "11:40",
        "Only the printer fix: CI failed on the Neptune print tests. The signing question is on Flynn, not you.",
      ),
    ]),
    previous: [
      chat("work-1", "15 – 26 Sep", "4 hand-offs, all done", [
        turn("wp1", "user", "Fri 17:05", "anything still open in work?"),
        turn(
          "wp2",
          "assistant",
          "Fri 17:05",
          "No. All four hand-offs from this stretch are done, so this chat closes.",
        ),
      ]),
    ],
  },
  {
    id: "section-northwind",
    kind: "section",
    nodeId: "section:work/northwind",
    name: "Northwind team",
    area: "Work › Northwind team",
    scope: "terminal-app, merchant-portal",
    current: chat("northwind-2", "Since Mon 28 Sep", "2 open", [
      turn(
        "wa1",
        "assistant",
        "Mon 14:31",
        "Watching: the terminal-app agent asked Flynn which Neptune calls need a signed build.",
        { delegationId: "d-neptune-questions" },
      ),
      turn(
        "wa2",
        "assistant",
        "Tue 16:21",
        "Watching: the A920 printer fix is a Task in terminal-app.",
        { delegationId: "d-printer-fix" },
      ),
    ]),
    previous: [],
  },
  {
    id: "section-personal",
    kind: "section",
    nodeId: "section:personal",
    name: "Personal",
    scope: "Personal › t3code",
    current: chat("personal-2", "Since Tue 29 Sep", "2 open", [
      turn(
        "p1",
        "handoff",
        "Tue 18:05",
        "Lease renewal reply for Mr. Alder. Start a chat so the user can read the draft.",
        { from: "assistant" },
      ),
      turn("p2", "assistant", "Tue 18:06", "Started a chat with the draft.", {
        delegationId: "d-lease-reply",
      }),
      turn(
        "p3",
        "assistant",
        "11:03",
        "Watching: the sidebar branch in t3code runs its checks before pushing.",
        { delegationId: "d-sidebar-review" },
      ),
    ]),
    previous: [
      chat("personal-1", "25 – 27 Sep", "1 hand-off, done", [
        turn(
          "pp1",
          "handoff",
          "Fri 19:12",
          "Porto long weekend this autumn, direct flights only.",
          { from: "assistant" },
        ),
        turn("pp2", "assistant", "Fri 19:13", "Started a chat for it.", {
          delegationId: "d-porto",
        }),
      ]),
    ],
  },
  {
    id: "project-t3code",
    kind: "project",
    nodeId: "project:t3code",
    name: "t3code",
    area: "Personal › t3code",
    scope: "threads in t3code",
    current: chat("t3code-1", "Since 11:02", "1 open", [
      turn(
        "t1",
        "handoff",
        "11:02",
        "Make codex-style-sidebar review-ready, then a draft PR. Start a Task.",
        { from: "assistant" },
      ),
      turn("t2", "assistant", "11:03", "Started a Task with Claude. It stops before pushing.", {
        delegationId: "d-sidebar-review",
      }),
      notificationTurn("t2n", "11:18", {
        delivery: "computer",
        reason: "approval needed",
        nodeId: "thread:sidebar-review",
        detail:
          "Tests and lint pass and the Task is blocked on your OK. You were at your computer.",
      }),
    ]),
    previous: [],
  },
  {
    id: "project-terminal-app",
    kind: "project",
    nodeId: "project:terminal-app",
    name: "terminal-app",
    area: "Work › Northwind team › terminal-app",
    scope: "threads in terminal-app",
    current: chat("terminal-1", "Since Mon 28 Sep", "2 open", [
      turn(
        "ta1",
        "handoff",
        "Mon 14:30",
        "Open question for the team: which Neptune calls need a signed build?",
        { from: "assistant" },
      ),
      turn(
        "ta2",
        "assistant",
        "Mon 14:31",
        "Started a chat. The Javadocs leave `cutPaper` open, so it's waiting on Flynn, who owns signing.",
        {
          delegationId: "d-neptune-questions",
        },
      ),
      turn(
        "ta3",
        "handoff",
        "Tue 16:20",
        "New Task: ship the A920 receipt printer fix. MR against develop when green.",
        { from: "assistant" },
      ),
      turn("ta4", "assistant", "Tue 16:21", "Started a Task with Codex.", {
        delegationId: "d-printer-fix",
      }),
    ]),
    previous: [],
  },
];

const titleCase = (key: string) =>
  key.replace(/[-_]+/g, " ").replace(/^\w/, (first) => first.toUpperCase());

/** A known agent, or a generic empty one named after the id ("project-foo" → "Foo"). */
export function resolveAgent(agentId: string): AgentFixture {
  const known = AGENTS.find((agent) => agent.id === agentId);
  if (known) return known;
  const workflow = agentId.startsWith("workflow-") ? workflowAgent(agentId) : null;
  if (workflow) return workflow;
  const kind = agentId.startsWith("project-")
    ? "project"
    : agentId.startsWith("workflow-")
      ? "workflow"
      : "section";
  const key = agentId.replace(/^(project|section|workflow)-/, "") || agentId;
  const name = kind === "section" ? titleCase(key) : key;
  const scope =
    kind === "project" ? `threads in ${name}` : kind === "workflow" ? `runs ${name}` : name;
  return {
    id: agentId,
    kind,
    nodeId: `${kind}:${key}`,
    name,
    scope,
    current: chat(`${agentId}-empty`, "Current", "Nothing open", []),
    previous: [],
  };
}

const isChatId = Schema.is(Schema.NonEmptyString);

export interface AgentSearch {
  /** An earlier chat from History. */
  readonly chat?: string;
  /** Prefills the composer, e.g. from Automations' "Ask agent to add…". */
  readonly prompt?: string;
}

export function validateAgentSearch(raw: Record<string, unknown>): AgentSearch {
  return {
    ...(isChatId(raw.chat) ? { chat: raw.chat } : {}),
    ...(isChatId(raw.prompt) ? { prompt: raw.prompt } : {}),
  };
}
