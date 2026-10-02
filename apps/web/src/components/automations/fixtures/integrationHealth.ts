/** PLACEHOLDER DATA: see automationFixtures.ts. */
import type { Automation, WorkflowNode } from "../automationModel";
import { hoursAgo, ok, run, skipped } from "./fixtureHelpers";

const SOURCE = `import { agent, notify, tool } from "@signalbox/automations";
import { on } from "@signalbox/automations/triggers";

export const trigger = on("Executor", "connection.failing", { consecutiveFailures: 3 });

export async function repairIntegration({ connection }: { connection: Connection }) {
  "use workflow";

  await agent("claudeAgent", {
    model: "Claude Opus 5.5",
    project: "executor",
    opens: "New chat",
    input: connection,
    prompt: \`\${connection.name} started failing. Read the recent errors, check
      credentials, scopes, and the upstream status page, and repair what you
      can. Never rotate secrets without asking.\`,
  });

  const health = await tool("Executor", "checkConnection", { connection: connection.id });
  if (health.ok) return;

  await notify(\`\${connection.name} is still failing and needs you.\`);
}
`;

const nodes: WorkflowNode[] = [
  {
    id: "trigger",
    title: "A connection starts failing",
    x: 0,
    y: 60,
    config: {
      kind: "trigger",
      source: "event",
      integration: "Executor",
      event: "connection.failing",
      filter: { consecutiveFailures: 3 },
    },
  },
  {
    id: "repair",
    title: "Try to repair it in a new chat",
    x: 300,
    y: 60,
    config: {
      kind: "agent",
      provider: "claudeAgent",
      providerLabel: "Claude Code",
      model: "Claude Opus 5.5",
      project: "executor",
      opens: "New chat",
      prompt:
        "{{connection.name}} started failing. Read the recent errors, check credentials, scopes, and the upstream status page, and repair what you can. Never rotate secrets without asking.",
    },
  },
  {
    id: "check",
    title: "Check the connection again",
    x: 600,
    y: 60,
    config: {
      kind: "tool",
      integration: "Executor",
      action: "Check connection",
      params: { connection: "{{connection.id}}" },
    },
  },
  {
    id: "healthy",
    title: "Healthy again?",
    x: 900,
    y: 60,
    config: {
      kind: "condition",
      expression: "health.ok",
      trueLabel: "Fixed",
      falseLabel: "Still failing",
    },
  },
  {
    id: "notify",
    title: "Ask me to step in",
    x: 1200,
    y: 120,
    config: {
      kind: "notify",
      importance: "urgent",
      message: "{{connection.name}} is still failing and needs you.",
    },
  },
];

function healthRun(id: string, hoursBack: number, connection: string, fixed: boolean) {
  return run(
    `health-${id}`,
    fixed ? `Repaired ${connection}` : `${connection} needs you`,
    hoursAgo(hoursBack),
    {
      trigger: ok(4, { connection, consecutiveFailures: 3 }),
      repair: ok(fixed ? 96_000 : 240_000, {
        diagnosis: fixed
          ? "OAuth token expired; refreshed through Executor."
          : "API returns 403 for every scope. The workspace admin revoked the app.",
      }),
      check: ok(1_400, { ok: fixed }),
      healthy: ok(1, { branch: fixed ? "true" : "false" }),
      notify: fixed ? skipped : ok(190, { delivered: 2 }),
    },
    "event",
  );
}

export const INTEGRATION_HEALTH: Automation = {
  id: "integration-health",
  name: "Repair failing integrations",
  description: "When an MCP server or API behind Executor fails, a chat tries to fix it first.",
  agentName: "Integration health agent",
  section: "personal",
  cadence: "On connection failing",
  enabled: true,
  nextRunAt: null,
  source: { path: "automations/integration-health.ts", code: SOURCE },
  nodes,
  edges: [
    { from: "trigger", to: "repair" },
    { from: "repair", to: "check" },
    { from: "check", to: "healthy" },
    { from: "healthy", to: "notify", branch: "false" },
  ],
  runs: [
    healthRun("a", 3, "Gmail", true),
    healthRun("b", 30, "Notion API", false),
    healthRun("c", 80, "Sentry MCP", true),
  ],
};
