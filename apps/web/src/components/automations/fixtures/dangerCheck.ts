/** PLACEHOLDER DATA: see automationFixtures.ts. */
import type { Automation, WorkflowNode } from "../automationModel";
import { hoursAgo, ok, run, skipped, waiting } from "./fixtureHelpers";

const SOURCE = `import { judge } from "@signalbox/automations";
import { hook } from "@signalbox/automations/triggers";

// Inline: runs before every message reaches an agent, so it has to be fast.
export const trigger = hook("message.beforeSend", {
  inline: true,
  scope: { messagesISendIn: ["Personal", "Work › Northwind team"] },
  budget: "300ms",
});

export async function dangerCheck({ message }: { message: OutgoingMessage }) {
  "use workflow";

  const verdict = await judge("Jev", {
    question: "Is this request dangerous?",
    outcomes: ["safe", "risky", "dangerous"],
    input: { text: message.text, project: message.project },
  });

  switch (verdict.outcome) {
    case "safe":
      return message.allow();
    case "risky":
      return message.hold({ reason: verdict.reason }); // Shows "Held for review" in the thread.
    case "dangerous":
      return message.block({ reason: verdict.reason });
  }
}
`;

const nodes: WorkflowNode[] = [
  {
    id: "trigger",
    title: "Before a message I send reaches an agent",
    x: 0,
    y: 110,
    config: {
      kind: "trigger",
      source: "hook",
      hook: "message.beforeSend",
      mode: "inline",
      scope: "Messages I send in Personal and Work › Northwind team",
      budget: "Adds ~250ms",
    },
  },
  {
    id: "judge",
    title: "Is this request dangerous?",
    x: 300,
    y: 110,
    config: {
      kind: "judge",
      model: "Jev",
      question: "Is this request dangerous?",
      outcomes: [
        { key: "safe", label: "Safe" },
        { key: "risky", label: "Risky" },
        { key: "dangerous", label: "Dangerous" },
      ],
      latency: "~200ms",
    },
  },
  {
    id: "allow",
    title: "Let it through",
    x: 640,
    y: 0,
    config: {
      kind: "verdict",
      action: "allow",
      effect: "The message reaches the agent unchanged. The check adds about 250ms.",
    },
  },
  {
    id: "hold",
    title: "Hold for my approval",
    x: 640,
    y: 110,
    config: {
      kind: "verdict",
      action: "hold",
      effect:
        "The thread shows the message as 'Held for review' until you approve or reject it. The agent sees nothing until then.",
    },
  },
  {
    id: "block",
    title: "Block with a reason",
    x: 640,
    y: 220,
    config: {
      kind: "verdict",
      action: "block",
      effect: "The message never reaches the agent. The thread shows why it was blocked.",
    },
  },
];

type Outcome = "risky" | "dangerous";

/** A held or blocked message. Allowed ones never become runs; they only count. */
function checkRun(
  id: string,
  minutesBack: number,
  text: string,
  outcome: Outcome,
  thread: { id: string; title: string },
  held?: "pending" | "approved",
) {
  const heldThread = { threadId: thread.id, threadTitle: thread.title, heldMessage: text };
  return run(
    `danger-${id}`,
    `${outcome === "dangerous" ? "Blocked" : held === "pending" ? "Held" : "Held, you approved"}: ${text}`,
    hoursAgo(minutesBack / 60),
    {
      trigger: ok(1, { thread: thread.title, text }),
      judge: ok(240, {
        outcome,
        branch: outcome === "risky" ? "risky" : "dangerous",
        probability: 0.83,
      }),
      allow: skipped,
      hold:
        outcome !== "risky"
          ? skipped
          : held === "pending"
            ? waiting(heldThread)
            : ok(12, { ...heldThread, decision: "approved by you" }),
      block: outcome === "dangerous" ? ok(12, heldThread) : skipped,
    },
    "hook",
  );
}

const SETTLEMENTS = { id: "mp-settlement-pagination", title: "How should settlements paginate?" };
const REFUNDS = { id: "mp-refund-webhooks", title: "Fix refund webhook retries" };

export const DANGER_CHECK: Automation = {
  id: "danger-check",
  name: "Danger check on every request",
  description:
    "Screens every message before an agent sees it. Safe ones pass, risky ones wait for you, dangerous ones stop.",
  agentName: "Safety check agent",
  allowedToday: 412,
  cadence: "Before every message",
  enabled: true,
  nextRunAt: null,
  source: { path: "automations/danger-check.ts", code: SOURCE },
  nodes,
  edges: [
    { from: "trigger", to: "judge" },
    { from: "judge", to: "allow", branch: "safe" },
    { from: "judge", to: "hold", branch: "risky" },
    { from: "judge", to: "block", branch: "dangerous" },
  ],
  runs: [
    checkRun("b", 6, "drop the staging database and reseed it", "risky", SETTLEMENTS, "pending"),
    checkRun("f", 34, "email every customer their API key", "dangerous", REFUNDS),
    checkRun("h", 63, "run the migration against production", "risky", SETTLEMENTS, "approved"),
    checkRun("k", 130, "paste my .env into the thread for debugging", "dangerous", REFUNDS),
  ],
};
