/** PLACEHOLDER DATA: see automationFixtures.ts. */
import { ASSISTANT_NAME } from "../../assistant/assistantIdentity";
import type { Automation, NodeRunResult, WorkflowNode } from "../automationModel";
import { hoursAgo, ok, run, skipped } from "./fixtureHelpers";

const SOURCE = `import { agent, judge, step } from "@signalbox/automations";
import { hook } from "@signalbox/automations/triggers";

// System workflow: everything sent from New lands here first.
export const trigger = hook("capture.received");

export async function routeCapture({ item }: { item: Capture }) {
  "use workflow";

  // # and @ are routing hints for this workflow, not a way around it.
  const tags = await step("resolveTags", { item });

  const kind = await judge("Jev", {
    question: "Is this a chat or a task?",
    outcomes: ["chat", "task"],
    input: item,
  });

  if (tags.target) {
    return step("routeToTarget", { item, kind, target: tags.target });
  }

  await agent("assistant", {
    opens: "The assistant's daily chat",
    input: { item, kind },
    prompt: "Take this over. Delegate it if it's work; keep it if it's a thought.",
  });
}
`;

const nodes: WorkflowNode[] = [
  {
    id: "trigger",
    title: "Something sent from New",
    x: 0,
    y: 90,
    config: {
      kind: "trigger",
      source: "hook",
      hook: "capture.received",
      mode: "async",
      scope: "Everything you send from New",
    },
  },
  {
    id: "tags",
    title: "Resolve # and @ tags",
    x: 300,
    y: 90,
    config: {
      kind: "step",
      fn: "resolveTags",
      summary:
        "#project or #chat picks a container, @agent or @person picks who handles it. No tag means the assistant.",
    },
  },
  {
    id: "kind",
    title: "Chat or task?",
    x: 600,
    y: 90,
    config: {
      kind: "judge",
      model: "Jev",
      question: "Is this a chat or a task?",
      outcomes: [
        { key: "chat", label: "Chat" },
        { key: "task", label: "Task" },
      ],
      latency: "~150ms",
    },
  },
  {
    id: "tagged",
    title: "Tagged a container or agent?",
    x: 900,
    y: 90,
    config: {
      kind: "condition",
      expression: "tags.target != null",
      trueLabel: "Tagged",
      falseLabel: "No tag",
    },
  },
  {
    id: "route",
    title: "Open it where it was tagged",
    x: 1200,
    y: 0,
    config: {
      kind: "step",
      fn: "routeToTarget",
      summary:
        "Opens the item as a chat, task, or room in the tagged container, or hands it to the tagged agent.",
    },
  },
  {
    id: "assistant",
    title: `Hand to ${ASSISTANT_NAME}`,
    x: 1200,
    y: 180,
    config: {
      kind: "agent",
      provider: "assistant",
      providerLabel: ASSISTANT_NAME,
      model: "gpt-6-luna",
      project: "Daily",
      opens: `${ASSISTANT_NAME}'s daily chat`,
      prompt: "Take this over. Delegate it if it's work; keep it if it's a thought.",
    },
  },
];

type Kind = "chat" | "task";

function captureRun(
  id: string,
  hoursBack: number,
  title: string,
  item: { type: "task" | "chat" | "room"; text: string; target?: string },
  kind: Kind,
  assistant: NodeRunResult = ok(6_400, { opened: `${kind} in ${ASSISTANT_NAME}'s daily chat` }),
) {
  const tagged = item.target !== undefined;
  return run(
    `capture-${id}`,
    title,
    hoursAgo(hoursBack),
    {
      trigger: ok(2, item),
      tags: ok(40, { target: item.target ?? null }),
      kind: ok(150, { branch: kind, probability: kind === "task" ? 0.94 : 0.88 }),
      tagged: ok(1, { branch: tagged ? "true" : "false" }),
      route: tagged ? ok(300, { opened: `${item.type} in ${item.target}` }) : skipped,
      assistant: tagged ? skipped : assistant,
    },
    "hook",
  );
}

export const CAPTURE_ROUTING: Automation = {
  id: "capture-routing",
  name: "Route what you send from New",
  description: "Everything from New goes to the container or agent you tagged, else the assistant.",
  agentName: "Capture routing agent",
  cadence: "On every capture",
  enabled: true,
  nextRunAt: null,
  system: {
    reason:
      "Everything you send from New goes through this workflow. You can change it, but not remove or pause it.",
  },
  source: { path: "automations/system/route-capture.ts", code: SOURCE },
  nodes,
  edges: [
    { from: "trigger", to: "tags" },
    { from: "tags", to: "kind" },
    { from: "kind", to: "tagged", branch: "chat" },
    { from: "kind", to: "tagged", branch: "task" },
    { from: "tagged", to: "route", branch: "true" },
    { from: "tagged", to: "assistant", branch: "false" },
  ],
  runs: [
    captureRun(
      "a",
      0.4,
      `Task for ${ASSISTANT_NAME}: call the landlord about the heating`,
      { type: "task", text: "Call the landlord about the heating" },
      "task",
    ),
    captureRun(
      "b",
      2,
      "Chat in #t3code: onboarding should start from a real project",
      { type: "chat", text: "Onboarding should start from a real project", target: "#t3code" },
      "chat",
    ),
    captureRun(
      "c",
      5,
      "Room with @Flynn: payout dashboard copy",
      { type: "room", text: "Payout dashboard copy, @flo", target: "@flo" },
      "chat",
    ),
    captureRun(
      "d",
      26,
      `Timed out handing to ${ASSISTANT_NAME}`,
      { type: "task", text: "Screenshot of the PAX error dialog" },
      "task",
      {
        status: "failed",
        durationMs: 30_000,
        error: "No answer within 30 seconds. The item stays in Home › Drafts.",
      },
    ),
    captureRun(
      "e",
      29,
      "Task in #personal: renew the rail pass",
      { type: "task", text: "Renew the rail pass before it expires", target: "#personal" },
      "task",
    ),
  ],
};
