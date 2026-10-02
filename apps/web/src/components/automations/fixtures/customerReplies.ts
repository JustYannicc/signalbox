/** PLACEHOLDER DATA: see automationFixtures.ts. */
import type { Automation, WorkflowNode } from "../automationModel";
import { NOW, hoursAgo, ok, run, shiftDays, waiting } from "./fixtureHelpers";

const SOURCE = `import { agent, approval, judge, step, tool } from "@signalbox/automations";
import { on } from "@signalbox/automations/triggers";

export const trigger = on("Zendesk", "ticket.created", { channel: "email" });

export async function prepareCustomerReply({ ticket }: { ticket: Ticket }) {
  "use workflow";

  const need = await judge("Jev", {
    question: "What does the customer need?",
    outcomes: ["question", "bug report", "billing", "refund request"],
    input: ticket,
  });

  const draft = await agent("claudeAgent", {
    model: "Claude Sonnet 5",
    project: "support-kb",
    opens: "New chat",
    input: { ticket, need, corrections: await step("loadCorrections") },
    prompt: \`Draft a reply in the customer's language. Cite the docs you rely on.
      Follow every past correction. Never promise refunds or dates.\`,
  });

  // The workflow sleeps here until you approve, edit, or reject the draft.
  const decision = await approval({ approver: "Yannic", prepared: draft });
  if (decision.rejected) return;

  await tool("Zendesk", "replyToTicket", { ticket: ticket.id, body: decision.text });
  await step("recordCorrections", { draft, sent: decision.text });
}
`;

const CORRECTIONS = [
  {
    at: shiftDays(NOW, -2).toISOString(),
    subject: "Refund for a double-charged terminal",
    note: "Don't promise a refund date. Say finance confirms within two business days.",
  },
  {
    at: shiftDays(NOW, -6).toISOString(),
    subject: "Firmware update stuck at 80%",
    note: "Link the recovery guide before suggesting a factory reset.",
  },
  {
    at: shiftDays(NOW, -11).toISOString(),
    subject: "Invoice address change",
    note: "German-speaking customers get 'Sie', never 'du'.",
  },
] as const;

const nodes: WorkflowNode[] = [
  {
    id: "trigger",
    title: "Customer email arrives",
    x: 0,
    y: 60,
    config: {
      kind: "trigger",
      source: "event",
      integration: "Zendesk",
      event: "ticket.created",
      filter: { channel: "email" },
    },
  },
  {
    id: "classify",
    title: "Classify the request",
    x: 300,
    y: 60,
    config: {
      kind: "judge",
      model: "Jev",
      question: "What does the customer need?",
      outcomes: [
        { key: "question", label: "Question" },
        { key: "bug", label: "Bug report" },
        { key: "billing", label: "Billing" },
        { key: "refund", label: "Refund request" },
      ],
      branches: false,
    },
  },
  {
    id: "draft",
    title: "Prepare a reply",
    x: 600,
    y: 60,
    config: {
      kind: "agent",
      provider: "claudeAgent",
      providerLabel: "Claude Code",
      model: "Claude Sonnet 5",
      project: "support-kb",
      opens: "New chat",
      prompt:
        "Draft a reply in the customer's language. Cite the docs you rely on. Follow every past correction. Never promise refunds or dates.",
    },
  },
  {
    id: "approve",
    title: "Approve the reply",
    x: 900,
    y: 60,
    config: {
      kind: "approval",
      approver: "Yannic",
      where: "Pipeline, routed to your devices by importance",
      prepares: "A reply draft plus the docs it cites. You can send it, edit it, or reject it.",
      corrections: CORRECTIONS,
    },
  },
  {
    id: "send",
    title: "Send the reply",
    x: 1200,
    y: 60,
    config: {
      kind: "tool",
      integration: "Zendesk",
      action: "Reply to ticket",
      params: { ticket: "{{ticket.id}}", public: true },
    },
  },
  {
    id: "learn",
    title: "Learn from your edits",
    x: 1500,
    y: 60,
    config: {
      kind: "step",
      fn: "recordCorrections",
      summary:
        "Compares the draft with what you sent and saves the difference as a correction. Later drafts load every correction first.",
    },
  },
];

const approved = (edited: boolean) => ({
  approve: ok(edited ? 1_260_000 : 540_000, { decision: edited ? "edited" : "sent as drafted" }),
  send: ok(900, { status: "sent" }),
  learn: ok(300, { corrections: edited ? 1 : 0 }),
});

export const CUSTOMER_REPLIES: Automation = {
  id: "customer-replies",
  name: "Prepare replies to customer emails",
  description: "Drafts a reply for every customer email and waits for your approval to send.",
  agentName: "Customer reply agent",
  section: "work",
  cadence: "On new support email",
  enabled: true,
  nextRunAt: null,
  source: { path: "automations/customer-replies.ts", code: SOURCE },
  nodes,
  edges: [
    { from: "trigger", to: "classify" },
    { from: "classify", to: "draft" },
    { from: "draft", to: "approve" },
    { from: "approve", to: "send" },
    { from: "send", to: "learn" },
  ],
  runs: [
    run(
      "reply-a",
      "Reply ready: terminal won't pair with the POS",
      hoursAgo(0.6),
      {
        trigger: ok(3, { from: "m.sommer@customer.example", subject: "Terminal won't pair" }),
        classify: ok(170, { label: "bug report", probability: 0.91 }),
        draft: ok(48_000, { chat: "Reply: terminal won't pair" }),
        approve: waiting({
          draft:
            "Grüezi Frau Sommer, danke für Ihre Nachricht. Bitte starten Sie das Terminal neu und koppeln Sie es danach erneut über Einstellungen › Verbindungen (Anleitung: docs.example.com/pairing). Falls es weiterhin nicht klappt, melden Sie sich bitte mit der Seriennummer des Geräts.",
          cites: ["docs.example.com/pairing"],
        }),
      },
      "event",
    ),
    run(
      "reply-b",
      "Sent after edits: refund for double charge",
      hoursAgo(49),
      {
        trigger: ok(3, { subject: "Charged twice for my terminal" }),
        classify: ok(160, { label: "refund request", probability: 0.97 }),
        draft: ok(51_000),
        ...approved(true),
      },
      "event",
    ),
    run(
      "reply-c",
      "Sent: how to export monthly reports",
      hoursAgo(75),
      {
        trigger: ok(3, { subject: "Monthly report export" }),
        classify: ok(150, { label: "question", probability: 0.95 }),
        draft: ok(33_000),
        ...approved(false),
      },
      "event",
    ),
  ],
};
