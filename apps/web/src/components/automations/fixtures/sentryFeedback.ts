/** PLACEHOLDER DATA: see automationFixtures.ts. */
import type { Automation, WorkflowNode } from "../automationModel";
import { failed, hoursAgo, ok, run, skipped } from "./fixtureHelpers";

const SOURCE = `import { agent, notify, tool } from "@signalbox/automations";
import { on } from "@signalbox/automations/triggers";

export const trigger = on("Sentry", "feedback.created", { project: "t3code-fork" });

export async function feedbackToFix({ feedback }: { feedback: SentryFeedback }) {
  "use workflow";

  const task = await agent("codex", {
    model: "gpt-6-astra",
    project: "t3code",
    opens: "New Task",
    input: feedback,
    prompt: \`A user reported this through Sentry feedback. Reproduce it from the
      attached replay and event, fix the root cause on a new branch, and add a
      focused test. Stop and explain if you cannot reproduce it.\`,
  });

  const pr = await tool("GitHub", "openPullRequest", {
    repository: "JustYannicc/t3code",
    branch: task.branch,
    title: task.title,
  });

  await notify(\`Fix ready for "\${feedback.message}": \${pr.url}\`);
}
`;

const nodes: WorkflowNode[] = [
  {
    id: "trigger",
    title: "User feedback received",
    x: 0,
    y: 60,
    config: {
      kind: "trigger",
      source: "event",
      integration: "Sentry",
      event: "feedback.created",
      filter: { project: "t3code-fork" },
    },
  },
  {
    id: "task",
    title: "Fix it in a new Task",
    x: 300,
    y: 60,
    config: {
      kind: "agent",
      provider: "codex",
      providerLabel: "Codex",
      model: "gpt-6-astra",
      project: "t3code",
      opens: "New Task",
      prompt:
        "A user reported this through Sentry feedback. Reproduce it from the attached replay and event, fix the root cause on a new branch, and add a focused test. Stop and explain if you cannot reproduce it.",
    },
  },
  {
    id: "pr",
    title: "Open the fix PR",
    x: 600,
    y: 60,
    config: {
      kind: "tool",
      integration: "GitHub",
      action: "Open pull request",
      params: { repository: "JustYannicc/t3code", branch: "{{task.branch}}" },
    },
  },
  {
    id: "notify",
    title: "Tell me the fix is ready",
    x: 900,
    y: 60,
    config: {
      kind: "notify",
      importance: "normal",
      message: 'Fix ready for "{{feedback.message}}": {{pr.url}}',
    },
  },
];

export const SENTRY_FEEDBACK: Automation = {
  id: "sentry-feedback-fix",
  name: "Turn Sentry feedback into fix PRs",
  description: "Starts a Codex task for each user feedback report and opens a PR with the fix.",
  agentName: "Sentry fixer agent",
  section: "personal",
  cadence: "On Sentry user feedback",
  enabled: true,
  nextRunAt: null,
  source: { path: "automations/sentry-feedback-fix.ts", code: SOURCE },
  nodes,
  edges: [
    { from: "trigger", to: "task" },
    { from: "task", to: "pr" },
    { from: "pr", to: "notify" },
  ],
  runs: [
    run(
      "feedback-a",
      "Fixing: sidebar jumps when a thread finishes",
      hoursAgo(0.3),
      {
        trigger: ok(3, { message: "Sidebar jumps when a thread finishes", user: "beta tester" }),
        task: { status: "running" },
      },
      "event",
    ),
    run(
      "feedback-b",
      "PR #58: diff names clipped at the bottom",
      hoursAgo(20),
      {
        trigger: ok(3, { message: "File names in the diff are cut off" }),
        task: ok(412_000, { thread: "Fix clipped diff file names", branch: "fix/diff-name-clip" }),
        pr: ok(2_300, { url: "https://github.com/JustYannicc/t3code/pull/58" }),
        notify: ok(210, { delivered: 2 }),
      },
      "event",
    ),
    run(
      "feedback-c",
      "Could not reproduce: blank settings page",
      hoursAgo(52),
      {
        trigger: ok(3, { message: "Settings page is blank" }),
        task: failed(
          610_000,
          "No replay was attached and the event has no stack. Asked the reporter for their browser version.",
        ),
        pr: skipped,
        notify: skipped,
      },
      "event",
    ),
  ],
};
