/** PLACEHOLDER DATA: see automationFixtures.ts. */
import type { Automation, WorkflowNode } from "../automationModel";
import { lastHourly, ok, failed, skipped, run } from "./fixtureHelpers";

const sentryNodes: WorkflowNode[] = [
  {
    id: "trigger",
    title: "Every hour",
    x: 0,
    y: 90,
    config: {
      kind: "trigger",
      source: "schedule",
      cron: "0 * * * *",
      timezone: "UTC",
      summary: "Hourly",
    },
  },
  {
    id: "list",
    title: "Fetch new issues",
    x: 300,
    y: 90,
    config: {
      kind: "tool",
      integration: "Sentry",
      action: "List issues",
      params: { project: "t3code-web", query: "is:unresolved firstSeen:-1h", limit: 20 },
    },
  },
  {
    id: "any",
    title: "New issues?",
    x: 600,
    y: 90,
    config: {
      kind: "condition",
      expression: "issues.length > 0",
      trueLabel: "Found",
      falseLabel: "None",
    },
  },
  {
    id: "triage",
    title: "Triage and draft fixes",
    x: 900,
    y: 0,
    config: {
      kind: "agent",
      provider: "claudeAgent",
      providerLabel: "Claude Code",
      model: "Claude Sonnet 5",
      project: "t3code",
      prompt:
        "For each issue, find the likely cause in the codebase, rate severity, and draft a minimal fix on its own branch when the cause is clear. Do not guess at fixes you cannot reproduce.",
    },
  },
  {
    id: "pr",
    title: "Open draft fix PRs",
    x: 1200,
    y: 0,
    config: {
      kind: "tool",
      integration: "GitHub",
      action: "Open pull request",
      params: { repository: "pingdotgg/t3code", draft: true, branch: "triage/{{issue.shortId}}" },
    },
  },
  {
    id: "slack",
    title: "Post triage summary",
    x: 1500,
    y: 0,
    config: {
      kind: "tool",
      integration: "Slack",
      action: "Post message",
      params: { channel: "#eng-alerts", text: "{{triage.summary}}" },
    },
  },
];

function sentryRun(
  hoursBack: number,
  issues: number,
  outcome: "done" | "running" | "failed" = "done",
) {
  const found = issues > 0;
  const title = !found
    ? "No new issues"
    : outcome === "running"
      ? `Triaging ${issues} new issues`
      : outcome === "failed"
        ? "Agent hit the turn limit"
        : `Triaged ${issues} issues`;
  return run(`sentry-${hoursBack}`, title, lastHourly(hoursBack), {
    trigger: ok(2),
    list: ok(610, { count: issues, issues: found ? ["T3CODE-WEB-4F2", "T3CODE-WEB-4F7"] : [] }),
    any: ok(1, { branch: found ? "true" : "false" }),
    ...(outcome === "running"
      ? { triage: { status: "running" as const } }
      : {
          triage: !found
            ? skipped
            : outcome === "failed"
              ? failed(
                  900_000,
                  "Stopped after 40 turns without a reproducible cause for T3CODE-WEB-4F2.",
                )
              : ok(214_000, { triaged: issues, fixes: 1 }),
          pr:
            found && outcome === "done"
              ? ok(2_600, { url: "https://github.com/pingdotgg/t3code/pull/14391" })
              : skipped,
          slack: found && outcome === "done" ? ok(410) : skipped,
        }),
  });
}

const SOURCE = `import { agent, tool } from "@signalbox/automations";
import { schedule } from "@signalbox/automations/triggers";

export const trigger = schedule("0 * * * *", { timezone: "UTC" });

export async function triageSentry() {
  "use workflow";

  const issues = await tool("Sentry", "listIssues", {
    project: "t3code-web",
    query: "is:unresolved firstSeen:-1h",
    limit: 20,
  });
  if (issues.length === 0) return;

  const triage = await agent("claudeAgent", {
    model: "Claude Sonnet 5",
    project: "t3code",
    prompt: \`For each issue, find the likely cause, rate severity, and draft a
      minimal fix on its own branch when the cause is clear.\`,
  });

  for (const fix of triage.fixes) {
    await tool("GitHub", "openPullRequest", {
      repository: "pingdotgg/t3code",
      draft: true,
      branch: \`triage/\${fix.issue.shortId}\`,
    });
  }
  await tool("Slack", "postMessage", { channel: "#eng-alerts", text: triage.summary });
}
`;

export const TRIAGE_SENTRY: Automation = {
  id: "triage-sentry",
  name: "Triage new Sentry issues",
  description: "Looks at new web errors every hour and drafts fixes for the clear ones.",
  agentName: "Sentry triage agent",
  section: "personal",
  cadence: "Hourly",
  enabled: true,
  nextRunAt: lastHourly(-1).toISOString(),
  source: { path: "automations/triage-sentry.ts", code: SOURCE },
  nodes: sentryNodes,
  edges: [
    { from: "trigger", to: "list" },
    { from: "list", to: "any" },
    { from: "any", to: "triage", branch: "true" },
    { from: "triage", to: "pr" },
    { from: "pr", to: "slack" },
  ],
  runs: [
    sentryRun(0, 3, "running"),
    sentryRun(1, 0),
    sentryRun(2, 2),
    sentryRun(3, 1, "failed"),
    sentryRun(4, 0),
    sentryRun(5, 1),
  ],
};
