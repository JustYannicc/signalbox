/** PLACEHOLDER DATA: see automationFixtures.ts. */
import type { Automation, RunIteration, WorkflowNode } from "../automationModel";
import { hoursAgo, ok, run, skipped } from "./fixtureHelpers";

const SOURCE = `import { agent, computer, gate, judge, notify, tool } from "@signalbox/automations";
import { hook } from "@signalbox/automations/triggers";

export const trigger = hook("spec.approved", { scope: { section: "Personal" } });

export async function specToPr({ spec }: { spec: Spec }) {
  "use workflow";

  const thread = await agent.start("codex", {
    model: "gpt-6-astra",
    project: "t3code",
    kind: "task",
    prompt: spec.body,
  });

  const passed = await gate({ maxIterations: 3 }, async () => {
    const review = await agent("claudeAgent", {
      prompt: \`Check this diff against the approved spec: \${thread.diff}\`,
    });
    const verdict = await judge("Jev", {
      question: "Does the review leave blocking findings?",
      outcomes: ["pass", "findings"],
      input: review,
    });
    if (verdict.outcome === "pass") return gate.pass();
    await agent.message(thread, { findings: review.findings });
    return gate.retry();
  });
  if (!passed) return notify(\`\${spec.title} needs you after 3 reviews.\`, { importance: "urgent" });

  // A fresh machine per run; it stops when the step ends.
  const qa = await computer("t3code-dev", {
    task: "Run the app, follow the spec's acceptance steps, and record a video.",
  });

  const pr = await tool("GitHub", "openPullRequest", {
    branch: thread.branch,
    body: \`\${spec.summary}\\n\\nQA recording: \${qa.recordingUrl}\`,
  });
  await notify(\`\${spec.title}: PR ready with QA video. \${pr.url}\`);
}
`;

const nodes: WorkflowNode[] = [
  {
    id: "trigger",
    title: "Spec approved",
    x: 0,
    y: 90,
    config: {
      kind: "trigger",
      source: "hook",
      hook: "spec.approved",
      mode: "async",
      scope: "Specs in the Personal section",
    },
  },
  {
    id: "implement",
    title: "Implement the spec",
    x: 320,
    y: 90,
    config: {
      kind: "agent",
      provider: "codex",
      providerLabel: "Codex",
      model: "gpt-6-astra",
      project: "t3code",
      opens: "New Task",
      unawareOfWorkflow: true,
      prompt: "{{spec.body}}",
    },
  },
  {
    id: "review",
    title: "Review against the spec",
    x: 620,
    y: 90,
    config: {
      kind: "agent",
      provider: "claudeAgent",
      providerLabel: "Claude Code",
      model: "Claude Opus 5.5",
      project: "t3code",
      prompt:
        "Check Codex's diff against the approved spec: every acceptance step covered, nothing outside the spec changed, tests cover the new behavior.",
    },
  },
  {
    id: "verdict",
    title: "Review passes?",
    x: 920,
    y: 90,
    config: {
      kind: "judge",
      model: "Jev",
      question: "Does the review leave blocking findings?",
      outcomes: [
        { key: "pass", label: "Passes" },
        { key: "findings", label: "Has findings" },
      ],
    },
  },
  {
    id: "retry",
    title: "Back to Codex?",
    x: 1220,
    y: 200,
    config: { kind: "gate", maxIterations: 3, retryLabel: "Try again", exitLabel: "Give up" },
  },
  {
    id: "handback",
    title: "Hand it back to me",
    x: 1520,
    y: 260,
    config: {
      kind: "notify",
      importance: "urgent",
      message: "{{spec.title}} needs you after 3 reviews.",
    },
  },
  {
    id: "qa",
    title: "QA in a live computer",
    x: 1220,
    y: 30,
    config: {
      kind: "computer",
      image: "t3code-dev (macOS)",
      task: "Run the app, follow the spec's acceptance steps, and record a video.",
      lifetime: "Starts on demand, stops when the step ends",
    },
  },
  {
    id: "pr",
    title: "Open the PR with the QA video",
    x: 1520,
    y: 30,
    config: {
      kind: "tool",
      integration: "GitHub",
      action: "Open pull request",
      params: { branch: "{{thread.branch}}", attach: "{{qa.recordingUrl}}" },
    },
  },
  {
    id: "notify",
    title: "Tell me the PR is ready",
    x: 1820,
    y: 30,
    config: {
      kind: "notify",
      importance: "normal",
      message: "{{spec.title}}: PR ready with QA video. {{pr.url}}",
    },
  },
];

function specRun(
  id: string,
  hoursBack: number,
  title: string,
  iterations: readonly RunIteration[],
  qaRunning = false,
) {
  const base = run(
    `spec-${id}`,
    title,
    hoursAgo(hoursBack),
    {
      trigger: ok(2),
      implement: ok(640_000 * iterations.length, { thread: title }),
      review: ok(110_000, { iteration: iterations.length, findings: 0 }),
      verdict: ok(700, { branch: "pass" }),
      retry: iterations.length > 1 ? ok(1, { branch: "true" }) : skipped,
      handback: skipped,
      qa: qaRunning
        ? { status: "running" }
        : ok(380_000, { computer: "t3code-dev-7f2", recording: "qa-recording.mp4" }),
      ...(qaRunning
        ? {}
        : {
            pr: ok(2_400, { url: "https://github.com/JustYannicc/t3code/pull/61" }),
            notify: ok(200),
          }),
    },
    "hook",
  );
  return { ...base, iterations };
}

export const SPEC_TO_PR: Automation = {
  id: "spec-to-pr",
  name: "Spec to reviewed, QA'd PR",
  description:
    "An approved spec gets implemented, reviewed until clean, tested in a live computer, and opened as a PR.",
  agentName: "Spec delivery agent",
  section: "personal",
  cadence: "On spec approved",
  enabled: true,
  nextRunAt: null,
  source: { path: "automations/spec-to-pr.ts", code: SOURCE },
  nodes,
  edges: [
    { from: "trigger", to: "implement" },
    { from: "implement", to: "review" },
    { from: "review", to: "verdict" },
    { from: "verdict", to: "qa", branch: "pass" },
    { from: "verdict", to: "retry", branch: "findings", retry: true },
    { from: "retry", to: "implement", branch: "true", loop: true },
    { from: "retry", to: "handback", branch: "false" },
    { from: "qa", to: "pr" },
    { from: "pr", to: "notify" },
  ],
  runs: [
    specRun(
      "a",
      1,
      "QA running: capture from the share sheet",
      [
        { status: "failed", findings: 2, summary: "Missing the offline acceptance step" },
        { status: "success", findings: 0, summary: "No findings" },
      ],
      true,
    ),
    specRun("b", 30, "PR #61: workspace breadcrumbs", [
      { status: "success", findings: 0, summary: "No findings", durationMs: 98_000 },
    ]),
  ],
};
