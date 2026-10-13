/**
 * PLACEHOLDER DATA for section and project agent pages, keyed by the level
 * each agent represents (`home`: a level key, or a real project matched by
 * name like the automation and place fixtures). Each level has one agent: it
 * coordinates the threads, tasks and automations there, spinning up a task or
 * chat for real work instead of doing everything itself. Agents of team levels
 * are shared with the team; agents of personal levels are just yours
 * (`levels/levelSharing`). Private chats stay private either way. When an
 * agent needs something above its level it asks up (`levels/askUp`): the
 * agent above lends it for the task, or does that piece and hands back only
 * what's needed. Each agent keeps one running chat that closes once all of its
 * work is done; earlier chats stay in History. Levels without a fixture get an
 * empty agent.
 */
import * as Schema from "effect/Schema";

import type { LevelOption } from "../levels/levelOptions";
import { resolveTarget, type ProjectRef } from "../sidebar/sections/mappedItems";
import { T3CODE_PROJECT, type HomeTarget } from "../spaces/spacesMappings";
import { notificationTurn, type ChatFixture, type TurnFixture } from "./assistantFixtures";
import { ASSISTANT_NAME } from "./assistantIdentity";

export interface AgentChatFixture extends ChatFixture {
  readonly id: string;
  /** "Since Tue 29 Sep", "15 – 26 Sep". */
  readonly title: string;
  /** One-line summary for History, e.g. "3 handoffs, all done". */
  readonly meta: string;
}

export interface AgentFixture {
  /** The level this agent represents. */
  readonly home: HomeTarget;
  /** Trace node the agent speaks as. */
  readonly nodeId: string;
  /** Used only when the level can't be found in Home. */
  readonly name: string;
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
    home: "section:work",
    nodeId: "section:work",
    name: "Work",
    current: chat("work-2", "Since Mon 28 Sep", "3 open", [
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
      turn(
        "w2a",
        "assistant",
        "Yesterday 17:30",
        `“Submit September expense report” needs receipts that only sit in your personal Gmail, outside Work. I asked ${ASSISTANT_NAME}: it kept the inbox and sent back just the 4 receipt PDFs that match the card charges. They're attached to the task.`,
      ),
      turn("w3", "user", "11:40", "anything in work that needs me today?"),
      turn(
        "w4",
        "assistant",
        "11:40",
        "Two things. The expense report waits on your OK to submit, and the printer fix failed CI on the Neptune print tests. The signing question is on Flynn, not you.",
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
    home: "section:work-northwind",
    nodeId: "section:work/northwind",
    name: "Northwind team",
    current: chat("northwind-2", "Since Mon 28 Sep", "4 open", [
      turn(
        "wa1",
        "assistant",
        "Mon 14:31",
        "Watching: the terminal-app agent asked Flynn which Neptune calls need a signed build.",
        { delegationId: "d-neptune-questions" },
      ),
      turn(
        "wa1b",
        "assistant",
        "Mon 15:02",
        "The terminal-app agent asked for the Northwind wiki to update the release checklist. Lent it read access for that task; the loan ended when the checklist was done.",
      ),
      turn(
        "wa2",
        "assistant",
        "Tue 16:21",
        "Watching: the A920 printer fix is a Task in terminal-app.",
        { delegationId: "d-printer-fix" },
      ),
      turn(
        "wa2b",
        "assistant",
        "09:40",
        "The merchant-portal agent needs the refund webhook's Sentry events for “Fix refund webhook retries”. Sentry sits with the team, so I lent read access to Northwind Sentry until that task ends.",
      ),
      turn(
        "wa3",
        "assistant",
        "10:12",
        `“Q4 roadmap with the team” asked about the board deck. It sits above this team, so I asked ${ASSISTANT_NAME}. ${ASSISTANT_NAME} kept the deck (it holds layoff plans, and engineers read that chat) and sent back only the runway and the Q4 target, which I passed on.`,
      ),
    ]),
    previous: [],
  },
  {
    home: "team-project:merchant-portal",
    nodeId: "project:merchant-portal",
    name: "merchant-portal",
    current: chat("merchant-1", "Since Wed 30 Sep", "2 open", [
      turn(
        "mp1",
        "assistant",
        "Wed 10:05",
        "Started a Task for Samir: review the payout dashboard copy. It waits on Samir's read-through.",
      ),
      turn(
        "mp2",
        "assistant",
        "09:38",
        "Started a Task with Codex: fix refund webhook retries. Flynn and Samir are in it.",
      ),
      turn(
        "mp3",
        "assistant",
        "09:40",
        "The task needs the refund webhook's Sentry events, and Sentry sits with the Northwind team, not here. Asked the Northwind agent: it lent read access until the task ends.",
      ),
    ]),
    previous: [],
  },
  {
    home: "section:personal",
    nodeId: "section:personal",
    name: "Personal",
    current: chat("personal-2", "Since Tue 29 Sep", "3 open", [
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
      turn(
        "p4",
        "assistant",
        "08:15",
        `“File the tax return” should land in your task list with its deadline. Todoist sits with ${ASSISTANT_NAME}, so I asked; it lent add-only access until the task is done.`,
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
        turn(
          "pp3",
          "assistant",
          "Fri 19:20",
          `Needed weekends without work travel. Personal can't see the Work calendar, so I asked ${ASSISTANT_NAME}: it sent back only the free weekends (17–19 and 24–26 Oct), nothing else from Work.`,
        ),
      ]),
    ],
  },
  {
    home: T3CODE_PROJECT,
    nodeId: "project:t3code",
    name: "t3code",
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
    home: "team-project:terminal-app",
    nodeId: "project:terminal-app",
    name: "terminal-app",
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
        "ta2b",
        "assistant",
        "Mon 15:00",
        "Started a Task: update the release checklist. The release process page is in the Northwind wiki, which sits with the team, so I asked the Northwind agent. It lent read access; that ended with the task.",
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

/** Whether a fixture's home is `level`; a project matched by name never falls back to a section. */
function isHome(fixture: AgentFixture, level: string, projects: readonly ProjectRef[]): boolean {
  const resolved = resolveTarget(fixture.home, projects);
  return typeof fixture.home === "string" || resolved !== fixture.home.fallback
    ? resolved === level
    : false;
}

const titleCase = (key: string) =>
  key.replace(/[-_]+/g, " ").replace(/^\w/, (first) => first.toUpperCase());

/**
 * The agent of `level` (the route's agent, found in Home), or a generic empty
 * one named after the level, or after the id when it isn't in Home.
 */
export function agentForLevel(
  agentId: string,
  level: LevelOption | null,
  projects: readonly ProjectRef[],
): AgentFixture {
  const known = level ? AGENTS.find((agent) => isHome(agent, level.key, projects)) : undefined;
  if (known) return known;
  const key = agentId.replace(/^(project|section)-/, "") || agentId;
  return {
    home: level?.key ?? agentId,
    nodeId: level?.key ?? agentId,
    name: level?.name ?? (agentId.startsWith("section-") ? titleCase(key) : key),
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
