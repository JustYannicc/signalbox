/** PLACEHOLDER DATA: see automationFixtures.ts. */
import type { Automation, WorkflowNode } from "../automationModel";
import { lastMonthlyAt, ok, failed, skipped, run } from "./fixtureHelpers";

const billNodes: WorkflowNode[] = [
  {
    id: "trigger",
    title: "On the 26th at 9:00 AM",
    x: 0,
    y: 90,
    config: {
      kind: "trigger",
      source: "schedule",
      cron: "0 9 26 * *",
      timezone: "Europe/Zurich",
      summary: "Monthly on the 26th",
    },
  },
  {
    id: "statement",
    title: "Find the card statement",
    x: 300,
    y: 90,
    config: {
      kind: "tool",
      integration: "Gmail",
      action: "Search messages",
      params: { query: "from:statements@card.example newer_than:7d", attachments: true },
    },
  },
  {
    id: "receipts",
    title: "Collect receipts",
    x: 600,
    y: 90,
    config: {
      kind: "tool",
      integration: "Google Drive",
      action: "List files",
      params: { folder: "Finance/Receipts/{{month}}", mimeType: "application/pdf" },
    },
  },
  {
    id: "match",
    title: "Match transactions to receipts",
    x: 900,
    y: 90,
    config: {
      kind: "agent",
      provider: "claudeAgent",
      providerLabel: "Claude Code",
      model: "Claude Opus 5.5",
      project: "finance-ops",
      prompt:
        "Read the statement PDF and match every transaction to a receipt in the listed files by amount, date, and merchant. Return the matched pairs and every transaction without evidence.",
    },
  },
  {
    id: "missing",
    title: "Missing receipts?",
    x: 1200,
    y: 90,
    config: {
      kind: "condition",
      expression: "match.unmatched.length > 0",
      trueLabel: "Missing",
      falseLabel: "All matched",
    },
  },
  {
    id: "email",
    title: "Email the missing receipts",
    x: 1500,
    y: 0,
    config: {
      kind: "tool",
      integration: "Gmail",
      action: "Send email",
      params: {
        to: "you@example.com",
        body: "{{match.unmatched.length}} transactions still need a receipt.",
      },
    },
  },
  {
    id: "file",
    title: "File the reconciled bill",
    x: 1500,
    y: 180,
    config: {
      kind: "tool",
      integration: "Google Drive",
      action: "Upload file",
      params: { folder: "Finance/Reconciled", name: "{{month}}-card-bill.pdf" },
    },
  },
];

function billRun(monthsBack: number, unmatched: number | "auth") {
  const startedAt = lastMonthlyAt(26, 9, monthsBack);
  const month = startedAt.toLocaleDateString("en-US", { month: "long" });
  if (unmatched === "auth") {
    return run(`bill-${monthsBack}`, "Gmail search failed", startedAt, {
      trigger: ok(4),
      statement: failed(1_200, "Gmail token expired. Reconnect Gmail in Executor.", {
        query: "from:statements@card.example newer_than:7d",
      }),
      receipts: skipped,
      match: skipped,
      missing: skipped,
      email: skipped,
      file: skipped,
    });
  }
  return run(
    `bill-${monthsBack}`,
    unmatched > 0 ? `${month} bill: ${unmatched} receipts missing` : `${month} bill fully matched`,
    startedAt,
    {
      trigger: ok(4),
      statement: ok(1_900, { messages: 1, attachment: `${month}-statement.pdf` }),
      receipts: ok(760, { files: 23 }),
      match: ok(94_000, {
        matched: 23 - unmatched,
        unmatched: unmatched > 0 ? ["Design tool subscription", "Train ticket"] : [],
      }),
      missing: ok(1, { branch: unmatched > 0 ? "true" : "false" }),
      email: unmatched > 0 ? ok(640, { sent: true }) : skipped,
      file: unmatched > 0 ? skipped : ok(1_400, { fileId: "demo-file-01" }),
    },
  );
}

const SOURCE = `import { agent, tool } from "@signalbox/automations";
import { schedule } from "@signalbox/automations/triggers";

export const trigger = schedule("0 9 26 * *", { timezone: "Europe/Zurich" });

export async function reconcileCardBill({ month }: { month: string }) {
  "use workflow";

  const statement = await tool("Gmail", "searchMessages", {
    query: "from:statements@card.example newer_than:7d",
    attachments: true,
  });
  const receipts = await tool("Google Drive", "listFiles", {
    folder: \`Finance/Receipts/\${month}\`,
    mimeType: "application/pdf",
  });

  const match = await agent("claudeAgent", {
    model: "Claude Opus 5.5",
    project: "finance-ops",
    input: { statement, receipts },
    prompt: "Match every transaction to a receipt by amount, date, and merchant.",
  });

  if (match.unmatched.length > 0) {
    return tool("Gmail", "sendEmail", {
      to: "you@example.com",
      body: \`\${match.unmatched.length} transactions still need a receipt.\`,
    });
  }
  await tool("Google Drive", "uploadFile", {
    folder: "Finance/Reconciled",
    name: \`\${month}-card-bill.pdf\`,
  });
}
`;

export const RECONCILE_CARD_BILL: Automation = {
  id: "reconcile-card-bill",
  name: "Reconcile monthly business card bill",
  description: "Matches the card statement to receipts in Drive and flags what is missing.",
  agentName: "Card bill agent",
  section: "work",
  cadence: "Monthly",
  enabled: true,
  nextRunAt: lastMonthlyAt(26, 9, -1).toISOString(),
  source: { path: "automations/reconcile-card-bill.ts", code: SOURCE },
  nodes: billNodes,
  edges: [
    { from: "trigger", to: "statement" },
    { from: "statement", to: "receipts" },
    { from: "receipts", to: "match" },
    { from: "match", to: "missing" },
    { from: "missing", to: "email", branch: "true" },
    { from: "missing", to: "file", branch: "false" },
  ],
  runs: [billRun(0, 2), billRun(1, "auth"), billRun(2, 0), billRun(3, 1)],
};
