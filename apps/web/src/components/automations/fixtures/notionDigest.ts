/** PLACEHOLDER DATA: see automationFixtures.ts. */
import type { Automation, WorkflowNode } from "../automationModel";
import { lastDailyAt, shiftDays, ok, failed, skipped, run } from "./fixtureHelpers";

const notionNodes: WorkflowNode[] = [
  {
    id: "trigger",
    title: "Mondays at 8:00 AM",
    x: 0,
    y: 60,
    config: {
      kind: "trigger",
      source: "schedule",
      cron: "0 8 * * 1",
      timezone: "Europe/Zurich",
      summary: "Weekly on Monday",
    },
  },
  {
    id: "query",
    title: "Collect last week's updates",
    x: 300,
    y: 60,
    config: {
      kind: "tool",
      integration: "Notion",
      action: "Query database",
      params: { database: "HQ / Tasks", filter: { property: "Updated", date: { past_week: {} } } },
    },
  },
  {
    id: "write",
    title: "Write the weekly digest",
    x: 600,
    y: 60,
    config: {
      kind: "agent",
      provider: "codex",
      providerLabel: "Codex",
      model: "gpt-6-luna",
      project: "hq-notes",
      prompt:
        "Summarize what moved, what stalled, and what needs a decision this week. Link every item to its Notion page.",
    },
  },
  {
    id: "page",
    title: "Create the digest page",
    x: 900,
    y: 60,
    config: {
      kind: "tool",
      integration: "Notion",
      action: "Create page",
      params: { parent: "HQ / Digests", title: "Week {{isoWeek}}" },
    },
  },
  {
    id: "slack",
    title: "Share in #hq",
    x: 1200,
    y: 60,
    config: {
      kind: "tool",
      integration: "Slack",
      action: "Post message",
      params: { channel: "#hq", text: "This week's digest: {{page.url}}" },
    },
  },
];

function notionRun(weeksBack: number, rateLimited = false) {
  const lastMorning = lastDailyAt(8);
  const lastMonday = shiftDays(lastMorning, -((lastMorning.getDay() + 6) % 7));
  const startedAt = shiftDays(lastMonday, -7 * weeksBack);
  return run(
    `notion-${weeksBack}`,
    rateLimited ? "Notion rate limited the page" : `Digest for week ${40 - weeksBack}`,
    startedAt,
    {
      trigger: ok(3),
      query: ok(1_300, { pages: 31 }),
      write: ok(52_000, { words: 420 }),
      page: rateLimited
        ? failed(8_000, "Notion API returned 429 three times.")
        : ok(900, { url: "notion.example/hq/digest-week" }),
      slack: rateLimited ? skipped : ok(300),
    },
  );
}

const SOURCE = `import { agent, tool } from "@signalbox/automations";
import { schedule } from "@signalbox/automations/triggers";

export const trigger = schedule("0 8 * * 1", { timezone: "Europe/Zurich" });

export async function notionDigest({ isoWeek }: { isoWeek: number }) {
  "use workflow";

  const updates = await tool("Notion", "queryDatabase", {
    database: "HQ / Tasks",
    filter: { property: "Updated", date: { past_week: {} } },
  });

  const digest = await agent("codex", {
    model: "gpt-6-luna",
    project: "hq-notes",
    input: updates,
    prompt: "Summarize what moved, what stalled, and what needs a decision this week.",
  });

  const page = await tool("Notion", "createPage", {
    parent: "HQ / Digests",
    title: \`Week \${isoWeek}\`,
    content: digest.text,
  });
  await tool("Slack", "postMessage", {
    channel: "#hq",
    text: \`This week's digest: \${page.url}\`,
  });
}
`;

export const NOTION_DIGEST: Automation = {
  id: "notion-digest",
  name: "Weekly Notion HQ digest",
  description: "Summarizes the week's HQ updates into a Notion page.",
  agentName: "Digest agent",
  section: "work",
  cadence: "Weekly on Monday",
  enabled: false,
  nextRunAt: null,
  source: { path: "automations/notion-digest.ts", code: SOURCE },
  nodes: notionNodes,
  edges: [
    { from: "trigger", to: "query" },
    { from: "query", to: "write" },
    { from: "write", to: "page" },
    { from: "page", to: "slack" },
  ],
  runs: [notionRun(3, true), notionRun(4), notionRun(5), notionRun(6)],
};
