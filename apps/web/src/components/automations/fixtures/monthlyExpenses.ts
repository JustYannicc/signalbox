/** PLACEHOLDER DATA: see automationFixtures.ts. */
import { ASSISTANT_NAME } from "../../assistant/assistantIdentity";
import type { Automation, WorkflowNode } from "../automationModel";
import { NORTHWIND, YANNIC, lastMonthlyAt, ok, run, skipped } from "./fixtureHelpers";

const SOURCE = `import { ASSISTANT, agent, handoff, tool } from "@signalbox/automations";
import { schedule } from "@signalbox/automations/triggers";

export const trigger = schedule("0 8 1 * *", { timezone: "Europe/Zurich" });

// Runs as Northwind's Expense agent. It has no access to Yannic's personal email,
// so it asks Yannic's own agent and only ever receives the receipts it returns.
export async function monthlyExpenses({ month }: { month: string }) {
  "use workflow";

  const charges = await agent("assistant", {
    name: "Expense agent",
    owner: "northwind",
    prompt: \`List \${month}'s charges on Yannic's business card that still need a receipt.\`,
  });

  const receipts = await handoff({
    from: "Expense agent",
    to: ASSISTANT,
    request: { receiptsFor: charges.missingReceipts },
    // Everything inside run() happens on Yannic's side, with Yannic's access.
    run: async (request) => {
      const emails = await tool("Gmail", "searchMessages", {
        account: "personal",
        query: "has:attachment (receipt OR invoice) newer_than:40d",
      });
      const picked = await agent("assistant", {
        name: ASSISTANT,
        input: { emails, charges: request.receiptsFor },
        prompt: "Return only the PDF receipts that match a listed charge.",
      });
      return { share: picked.receipts }; // PDFs only. Nothing else leaves.
    },
  });

  const report = await tool("Northwind Expenses", "submitReport", { month, receipts });
  if (report.missing.length > 0) {
    await tool("Slack", "postMessage", {
      channel: "@yannic",
      text: \`\${report.missing.length} charges still need a receipt.\`,
    });
  }
}
`;

const nodes: WorkflowNode[] = [
  {
    id: "trigger",
    title: "On the 1st at 8:00 AM",
    x: 0,
    y: 40,
    owner: NORTHWIND,
    config: {
      kind: "trigger",
      source: "schedule",
      cron: "0 8 1 * *",
      timezone: "Europe/Zurich",
      summary: "Monthly on the 1st",
    },
  },
  {
    id: "charges",
    title: "List charges without receipts",
    x: 300,
    y: 40,
    owner: NORTHWIND,
    config: {
      kind: "agent",
      provider: "assistant",
      providerLabel: "Expense agent",
      model: "Claude Sonnet 5",
      project: "Northwind Finance",
      prompt: "List last month's charges on Yannic's business card that still need a receipt.",
    },
  },
  {
    id: "ask",
    title: "Ask Yannic's agent for receipts",
    x: 600,
    y: 40,
    owner: NORTHWIND,
    config: {
      kind: "handoff",
      from: "Expense agent",
      to: ASSISTANT_NAME,
      request: "Receipts for the listed charges: merchant, date, and amount for each.",
      shares: ["The charges that need a receipt (merchant, date, amount)"],
      withheld: ["Other card transactions", "Northwind documents and mail"],
      scopeNote:
        "The Expense agent represents Northwind. It sends only the list of charges it needs receipts for.",
    },
  },
  {
    id: "search",
    title: "Search personal Gmail",
    x: 900,
    y: 240,
    owner: YANNIC,
    config: {
      kind: "tool",
      integration: "Gmail",
      action: "Search messages",
      params: { account: "personal", query: "has:attachment (receipt OR invoice) newer_than:40d" },
    },
  },
  {
    id: "pick",
    title: "Pick the matching receipts",
    x: 1200,
    y: 240,
    owner: YANNIC,
    config: {
      kind: "agent",
      provider: "assistant",
      providerLabel: ASSISTANT_NAME,
      model: "gpt-6-luna",
      project: "Personal",
      prompt:
        "Compare the emails with the listed charges. Return only the PDF receipts that match a charge by merchant, date, and amount.",
    },
  },
  {
    id: "give",
    title: "Hand over matching receipts",
    x: 1500,
    y: 240,
    owner: YANNIC,
    config: {
      kind: "handoff",
      from: ASSISTANT_NAME,
      to: "Expense agent",
      request: "Only the receipts that match a listed charge.",
      shares: ["Matching receipts as PDF files", "Which charge each receipt belongs to"],
      withheld: [
        "Access to your personal mailbox",
        "Email bodies, threads, and senders",
        "Emails that did not match",
        "Your search queries",
      ],
      scopeNote: `${ASSISTANT_NAME} works for you and searches with your access. The Expense agent never sees your inbox. It only receives the files ${ASSISTANT_NAME} hands over.`,
    },
  },
  {
    id: "file",
    title: "Submit the expense report",
    x: 1800,
    y: 40,
    owner: NORTHWIND,
    config: {
      kind: "tool",
      integration: "Northwind Expenses",
      action: "Submit report",
      params: { month: "{{month}}", receipts: "{{give.receipts}}" },
    },
  },
  {
    id: "notify",
    title: "Flag what is still missing",
    x: 2100,
    y: 40,
    owner: NORTHWIND,
    config: {
      kind: "tool",
      integration: "Slack",
      action: "Post message",
      params: {
        channel: "@yannic in Northwind Slack",
        text: "{{report.missing.length}} charges still need a receipt.",
      },
    },
  },
];

function expensesRun(monthsBack: number, charges: number, found: number) {
  const startedAt = lastMonthlyAt(1, 8, monthsBack);
  const month = new Date(startedAt.getFullYear(), startedAt.getMonth() - 1).toLocaleDateString(
    "en-US",
    { month: "long" },
  );
  const missing = charges - found;
  return run(
    `expenses-${monthsBack}`,
    missing > 0
      ? `${month}: ${found} receipts shared, ${missing} missing`
      : `${month}: all ${found} receipts shared`,
    startedAt,
    {
      trigger: ok(3),
      charges: ok(38_000, { needReceipts: charges }),
      ask: ok(400, { requested: charges }),
      search: ok(2_600, { emails: 17 }),
      pick: ok(41_000, { matched: found, ignored: 17 - found }),
      give: ok(900, { shared: `${found} receipts (PDF)`, nothingElse: true }),
      file: ok(3_100, { report: `${month}-expenses`, missing }),
      notify: missing > 0 ? ok(350) : skipped,
    },
  );
}

export const MONTHLY_EXPENSES: Automation = {
  id: "monthly-expenses",
  name: "Monthly expenses",
  description: `Northwind's Expense agent gets your receipts from ${ASSISTANT_NAME} without seeing your inbox.`,
  agentName: "Receipts handoff agent",
  section: "work",
  cadence: "Monthly on the 1st",
  enabled: true,
  nextRunAt: lastMonthlyAt(1, 8, -1).toISOString(),
  source: { path: "automations/monthly-expenses.ts", code: SOURCE },
  nodes,
  lanes: [
    { owner: NORTHWIND, y: -10, height: 160 },
    { owner: YANNIC, y: 170, height: 160 },
  ],
  edges: [
    { from: "trigger", to: "charges" },
    { from: "charges", to: "ask" },
    { from: "ask", to: "search", label: "asks: receipts for 6 charges", boundary: true },
    { from: "search", to: "pick" },
    { from: "pick", to: "give" },
    { from: "give", to: "file", label: "shares: 4 receipts (PDF) · nothing else", boundary: true },
    { from: "file", to: "notify" },
  ],
  runs: [expensesRun(0, 6, 4), expensesRun(1, 5, 5), expensesRun(2, 8, 7)],
};
