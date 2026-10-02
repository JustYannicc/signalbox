/**
 * PLACEHOLDER DATA for the Assistant prototype. Nothing here comes from a
 * server: agents, hand-offs and conversations are invented so the page reads
 * like a real morning. Replace with orchestration read models.
 *
 * Routing is direct: the assistant hands work to the agent of the container
 * that owns it (or straight to a top-level thread). Parent supervisors observe
 * work in their containers; they are not relays.
 */
import { ProviderDriverKind } from "@t3tools/contracts";

import type { ThreadDisplayStatus } from "../threadStatusDisplay";
import { ASSISTANT_NAME } from "./assistantIdentity";

export type NotificationDelivery = "none" | "computer" | "phone";
/** The Pipeline's statuses; "waiting" names its person in `waitingOn`. */
export type DelegationStatus = ThreadDisplayStatus;
export type ThreadKind = "chat" | "task";
export type TraceNodeKind =
  | "assistant"
  | "section"
  | "project"
  | "workflow"
  | "trigger"
  | "automations"
  | "thread";

export interface GroupFixture {
  readonly id: string;
  readonly name: string;
  /** What the group bundles, e.g. which accounts its tools act as. */
  readonly description: string;
}

export interface TraceNodeFixture {
  readonly id: string;
  readonly kind: TraceNodeKind;
  readonly name: string;
  /** Where the node lives, outermost first, e.g. ["Work", "Northwind team"]. */
  readonly path: readonly string[];
  readonly groupId?: string;
  readonly threadKind?: ThreadKind;
  readonly harness?: ProviderDriverKind;
  /** A shared chat (`/shared/$threadId`) this thread opens as. */
  readonly sharedThreadId?: string;
}

export interface HopFixture {
  /** Node receiving this hop; the sender is the previous hop's target, or the origin. */
  readonly to: string;
  readonly at: string;
  readonly message: string;
  readonly status: DelegationStatus;
}

export interface DelegationFixture {
  readonly id: string;
  /** Who started it; the assistant unless e.g. an automation's trigger did. */
  readonly origin?: string;
  readonly at: string;
  readonly status: DelegationStatus;
  /** Set with status "waiting": the person it waits on. */
  readonly waitingOn?: string;
  /** Verb phrase completing "Asked <target> to …". */
  readonly summary: string;
  /** The exact message the origin sent. */
  readonly message: string;
  readonly groupId: string;
  readonly hops: readonly HopFixture[];
  readonly statusDetail: string;
  readonly approval?: { readonly question: string; readonly command: string };
}

export interface LookupFixture {
  readonly tool: "gmail" | "calendar" | "jira" | "sentry" | "github";
  /** The named account the lookup read through, as models see it. */
  readonly account: string;
  readonly groupId: string;
  readonly query: string;
  readonly result: string;
}

export type AssistantBlock =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "delegation"; readonly delegationId: string }
  | { readonly kind: "lookup"; readonly lookup: LookupFixture }
  /** Whether the speaker pinged the user about an update, and why. */
  | {
      readonly kind: "notification";
      /** Where it landed: nowhere, a quiet badge on the computer, or a phone push. */
      readonly delivery: NotificationDelivery;
      readonly reason: string;
      /** The trace node the update was about. */
      readonly nodeId: string;
      readonly detail: string;
    }
  /** A link card to an automation's workflow page. */
  | { readonly kind: "automation"; readonly automationId: string; readonly label: string };

export interface TurnFixture {
  readonly id: string;
  /** "handoff" is work arriving from another agent; `from` names the sender node. */
  readonly role: "user" | "assistant" | "handoff";
  readonly from?: string;
  readonly at: string;
  readonly blocks: readonly AssistantBlock[];
  /** Files the user attached to this message. */
  readonly files?: readonly { readonly name: string; readonly size: number }[];
}

export interface ChatFixture {
  /** Still-open items compacted from the previous chat, each pointing at its hand-off. */
  readonly carriedOver: readonly { readonly delegationId: string; readonly note: string }[];
  readonly turns: readonly TurnFixture[];
}

/**
 * One assistant chat. A new one starts on the first open after 4:00, or after a
 * long idle stretch; anything still open is carried over.
 */
export interface DayFixture extends ChatFixture {
  /** ISO calendar date, also the `day` search param. */
  readonly date: string;
}

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");

export const ASSISTANT_GROUPS: readonly GroupFixture[] = [
  { id: "northwind", name: "Northwind", description: "Work Gmail, Northwind GitLab, Jira, Sentry" },
  { id: "personal", name: "Personal", description: "Personal Gmail, GitHub, Calendar, Todoist" },
];

export const TRACE_NODES: readonly TraceNodeFixture[] = [
  { id: "assistant", kind: "assistant", name: ASSISTANT_NAME, path: [] },
  { id: "section:work", kind: "section", name: "Work", path: [], groupId: "northwind" },
  {
    id: "section:work/northwind",
    kind: "section",
    name: "Northwind team",
    path: ["Work"],
    groupId: "northwind",
  },
  { id: "section:personal", kind: "section", name: "Personal", path: [], groupId: "personal" },
  {
    id: "project:t3code",
    kind: "project",
    name: "t3code",
    path: ["Personal"],
    groupId: "personal",
  },
  {
    id: "project:terminal-app",
    kind: "project",
    name: "terminal-app",
    path: ["Work", "Northwind team"],
    groupId: "northwind",
  },
  { id: "automations", kind: "automations", name: "Automations", path: [] },
  {
    id: "thread:sentry-fix-pr",
    kind: "thread",
    name: "Sentry feedback → fix PR",
    path: ["Automations"],
    threadKind: "task",
    harness: codex,
    groupId: "personal",
  },
  {
    id: "thread:sidebar-review",
    kind: "thread",
    name: "Sidebar ready for review",
    path: ["Personal", "t3code"],
    threadKind: "task",
    harness: claude,
    groupId: "personal",
  },
  {
    id: "thread:printer-fix",
    kind: "thread",
    name: "Ship A920 receipt printer fix",
    path: ["Work", "Northwind team", "terminal-app"],
    threadKind: "task",
    harness: codex,
    groupId: "northwind",
    sharedThreadId: "ta-printer-fix",
  },
  {
    id: "thread:neptune-questions",
    kind: "thread",
    name: "Which Neptune calls need a signed build?",
    path: ["Work", "Northwind team", "terminal-app"],
    threadKind: "chat",
    harness: claude,
    groupId: "northwind",
    sharedThreadId: "ta-neptune-questions",
  },
  {
    id: "thread:lease-reply",
    kind: "thread",
    name: "Lease renewal reply",
    path: ["Personal"],
    threadKind: "chat",
    harness: claude,
    groupId: "personal",
  },
  {
    id: "thread:someday",
    kind: "thread",
    name: "Someday",
    path: [],
    threadKind: "chat",
    harness: claude,
    groupId: "personal",
  },
  {
    id: "thread:porto-weekend",
    kind: "thread",
    name: "Porto weekend",
    path: ["Personal"],
    threadKind: "chat",
    harness: claude,
    groupId: "personal",
  },
];

export const DELEGATIONS: readonly DelegationFixture[] = [
  {
    id: "d-printer-fix",
    at: "Tue 16:20",
    status: "failed",
    summary: "ship the A920 receipt printer fix",
    message:
      "Ship the A920 receipt printer fix in terminal-app: keep the Neptune printer receipt in sync after partial refunds, and open an MR against develop when CI is green.",
    groupId: "northwind",
    hops: [
      {
        to: "project:terminal-app",
        at: "Tue 16:20",
        status: "done",
        message: "New Task: ship the A920 receipt printer fix. MR against develop when green.",
      },
      {
        to: "thread:printer-fix",
        at: "Tue 16:21",
        status: "failed",
        message:
          "Fix the A920 receipt printing after partial refunds. Keep the Neptune receipt in sync.",
      },
    ],
    statusDetail: "CI failed on the Neptune print tests overnight",
  },
  {
    id: "d-lease-reply",
    at: "Tue 18:05",
    status: "input",
    summary: "draft a reply to Mr. Alder about renewing the lease",
    message:
      "Draft a reply to Mr. Alder: I'd like to renew the lease for one year. Ask whether the rent stays the same. Keep it short.",
    groupId: "personal",
    hops: [
      {
        to: "section:personal",
        at: "Tue 18:05",
        status: "done",
        message: "Lease renewal reply for Mr. Alder. Start a chat so the user can read the draft.",
      },
      {
        to: "thread:lease-reply",
        at: "Tue 18:06",
        status: "input",
        message: "Draft a short reply: renew for one year, ask if the rent stays the same.",
      },
    ],
    statusDetail: "Draft ready. Which date should the renewal start?",
  },
  {
    id: "d-neptune-questions",
    at: "Mon 14:30",
    status: "waiting",
    waitingOn: "Flynn",
    summary: "find out which Neptune calls need a signed build",
    message: "Find out which Neptune printer calls need a signed build before the A920 rollout.",
    groupId: "northwind",
    hops: [
      {
        to: "project:terminal-app",
        at: "Mon 14:30",
        status: "done",
        message: "Open question for the team: which Neptune calls need a signed build?",
      },
      {
        to: "thread:neptune-questions",
        at: "Mon 14:31",
        status: "waiting",
        message: "Compare the Javadocs and ask Flynn, who owns signing.",
      },
    ],
    statusDetail: "Asked Flynn, who owns signing",
  },
  {
    id: "d-sentry",
    at: "09:04",
    status: "working",
    summary: "build a workflow that turns Sentry feedback into fix PRs",
    message:
      "Build an automation: whenever new Sentry user feedback comes in for t3code, open a Task in the t3code project that reproduces the issue and opens a fix PR. Ask me before the first real run.",
    groupId: "personal",
    hops: [
      {
        to: "automations",
        at: "09:04",
        status: "done",
        message: "New workflow: Sentry feedback → Task in t3code → fix PR.",
      },
      {
        to: "thread:sentry-fix-pr",
        at: "09:05",
        status: "working",
        message:
          "Draft the workflow: trigger on Sentry user feedback, start a Task in t3code, open a fix PR. Hold before the first real run.",
      },
    ],
    statusDetail: "Drafting the trigger and the Task template",
  },
  {
    id: "d-skydiving",
    at: "10:17",
    status: "done",
    summary: "add “go skydiving one day” to Someday",
    message: "Add to Someday: “should go skydiving one day”. No date, no reminder.",
    groupId: "personal",
    hops: [
      {
        to: "thread:someday",
        at: "10:17",
        status: "done",
        message: "Add “should go skydiving one day”. No date, no reminder.",
      },
    ],
    statusDetail: "Added to Someday",
  },
  {
    id: "d-sidebar-review",
    at: "11:02",
    status: "approval",
    summary: "get the codex-style sidebar branch ready for review",
    message:
      "Get t3code/codex-style-sidebar ready for review: run the focused tests and lint for the changed files, fix what fails, then push and open a draft PR.",
    groupId: "personal",
    hops: [
      {
        to: "project:t3code",
        at: "11:02",
        status: "done",
        message: "Make codex-style-sidebar review-ready, then a draft PR. Start a Task.",
      },
      {
        to: "thread:sidebar-review",
        at: "11:03",
        status: "approval",
        message:
          "Run focused tests and lint on the changed files, fix failures, then push and open a draft PR.",
      },
    ],
    statusDetail: "Tests and lint pass. Wants to push",
    approval: {
      question: "Push the branch and open a draft PR?",
      command: "git push -u origin t3code/codex-style-sidebar",
    },
  },
  {
    id: "d-porto",
    at: "Fri 19:12",
    status: "done",
    summary: "sketch a long weekend in Porto",
    message: "Sketch a long weekend in Porto sometime this autumn. Direct flights only.",
    groupId: "personal",
    hops: [
      {
        to: "section:personal",
        at: "Fri 19:12",
        status: "done",
        message: "Porto long weekend this autumn, direct flights only.",
      },
      {
        to: "thread:porto-weekend",
        at: "Fri 19:13",
        status: "done",
        message: "Sketch a Porto long weekend this autumn. Direct flights only.",
      },
    ],
    statusDetail: "Two flight options and a rough plan",
  },
];

/** A turn holding only a notification decision. */
export const notificationTurn = (
  id: string,
  at: string,
  notice: { delivery: NotificationDelivery; reason: string; nodeId: string; detail: string },
): TurnFixture => ({ id, role: "assistant", at, blocks: [{ kind: "notification", ...notice }] });

const user = (id: string, at: string, text: string): TurnFixture => ({
  id,
  role: "user",
  at,
  blocks: [{ kind: "text", text }],
});

const reply = (
  id: string,
  at: string,
  text: string,
  ...rest: readonly AssistantBlock[]
): TurnFixture => ({ id, role: "assistant", at, blocks: [{ kind: "text", text }, ...rest] });

export const ASSISTANT_DAYS: readonly DayFixture[] = [
  {
    date: "2026-09-30",
    carriedOver: [
      {
        delegationId: "d-printer-fix",
        note: "CI failed on the Neptune print tests. Needs a rerun or a fix before the MR.",
      },
      {
        delegationId: "d-lease-reply",
        note: "Draft is ready. Needs the date the renewal starts.",
      },
      {
        delegationId: "d-neptune-questions",
        note: "Waiting on Flynn for the list of calls that need signing.",
      },
    ],
    turns: [
      notificationTurn("t0", "06:30", {
        delivery: "none",
        reason: "printer fix CI still red, already carried over",
        nodeId: "thread:printer-fix",
        detail:
          "The overnight retry failed the same Neptune print tests. It's already on today's list, so a ping would add nothing.",
      }),
      user("t1", "09:04", "set up a workflow so every Sentry feedback gets a fix PR. t3code only"),
      reply(
        "t2",
        "09:04",
        "Handed to Automations. The workflow holds before its first real run, so that run needs your OK.",
        { kind: "delegation", delegationId: "d-sentry" },
      ),
      user("t3", "09:31", "did Nora ever get back to me about the merchant portal release?"),
      {
        id: "t4",
        role: "assistant",
        at: "09:31",
        blocks: [
          {
            kind: "lookup",
            lookup: {
              tool: "gmail",
              account: "yannic@northwind.example",
              groupId: "northwind",
              query: "from:nora release newer_than:14d",
              result: "1 thread, 3 messages read. Nothing sent or changed.",
            },
          },
          {
            kind: "text",
            text: "Yes, Tuesday afternoon. She wants the release pushed back a week so support has time to prepare. She isn't waiting on anything from you.",
          },
        ],
      },
      notificationTurn("t4n", "09:40", {
        delivery: "none",
        reason: "workflow draft saved, nothing needs you",
        nodeId: "thread:sentry-fix-pr",
        detail:
          "Automations saved the draft. It won't run until you approve the first run, which gets its own ping.",
      }),
      user("t5", "10:17", "should go skydiving one day"),
      reply("t6", "10:17", "On the Someday list. No date, no reminder.", {
        kind: "delegation",
        delegationId: "d-skydiving",
      }),
      user("t7", "11:02", "can you get the codex-style sidebar branch in t3code ready for review"),
      reply(
        "t8",
        "11:02",
        "Handed to the t3code agent. It runs the checks and stops before pushing.",
        { kind: "delegation", delegationId: "d-sidebar-review" },
      ),
      reply(
        "t9",
        "11:18",
        "Tests and lint pass on the sidebar branch. It wants to push and open a draft PR. Your call.",
        {
          kind: "notification",
          delivery: "computer",
          reason: "approval needed",
          nodeId: "thread:sidebar-review",
          detail: "You were at your computer, so it's a quiet badge and a sidebar marker.",
        },
      ),
      notificationTurn("t9n", "11:35", {
        delivery: "phone",
        reason: "urgent: approval still waiting",
        nodeId: "thread:sidebar-review",
        detail: "You'd stepped away and the Task is blocked on you, so it went to your phone.",
      }),
    ],
  },
  {
    date: "2026-09-29",
    carriedOver: [
      {
        delegationId: "d-neptune-questions",
        note: "Waiting on Flynn for the list of calls that need signing.",
      },
    ],
    turns: [
      user("y1", "16:20", "the A920 receipt printer fix needs to ship, can you kick that off"),
      reply(
        "y2",
        "16:20",
        "Handed to the terminal-app agent. It opens an MR against develop once CI is green.",
        { kind: "delegation", delegationId: "d-printer-fix" },
      ),
      user("y3", "18:05", "reply to Alder about the lease, I want to renew for a year"),
      reply("y4", "18:05", "Started a chat under Personal so you can read the draft first.", {
        kind: "delegation",
        delegationId: "d-lease-reply",
      }),
    ],
  },
  {
    date: "2026-09-28",
    carriedOver: [],
    turns: [
      user("m1", "14:30", "which neptune calls actually need a signed build?"),
      reply(
        "m2",
        "14:30",
        "Handed to the terminal-app agent. Flynn owns signing, so the open question goes to him.",
        {
          kind: "delegation",
          delegationId: "d-neptune-questions",
        },
      ),
    ],
  },
  {
    date: "2026-09-25",
    carriedOver: [],
    turns: [
      user("f1", "19:12", "porto long weekend sometime this autumn? direct flights only"),
      reply("f2", "19:12", "Handed to a new chat under Personal.", {
        kind: "delegation",
        delegationId: "d-porto",
      }),
    ],
  },
];
