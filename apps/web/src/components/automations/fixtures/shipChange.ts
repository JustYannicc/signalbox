/** PLACEHOLDER DATA: see automationFixtures.ts. */
import type { Automation, RunIteration, WorkflowNode } from "../automationModel";
import { hoursAgo, ok, run, skipped } from "./fixtureHelpers";

const SOURCE = `import { agent, gate, judge, notify, tool } from "@signalbox/automations";
import { hook, webhook } from "@signalbox/automations/triggers";

export const triggers = [
  hook("task.markedDone", { scope: { project: "t3code" } }),
  webhook("POST", "/hooks/github", { event: "pull_request.opened" }),
];

export async function shipChange({ task }: { task: Task }) {
  "use workflow";

  const passed = await gate({ maxIterations: 5 }, async () => {
    // A different harness reviews than the one that wrote the change.
    const review = await agent("claudeAgent", {
      model: "Claude Opus 5.5",
      prompt: \`Review this diff against the request and AGENTS.md: \${task.diff}\`,
    });
    const verdict = await judge("Claude Haiku 5", {
      question: "Does the review leave blocking findings?",
      outcomes: ["pass", "findings"],
      input: review,
    });
    if (verdict.outcome === "pass") return gate.pass();

    // The implementing agent just gets a message. It never sees this workflow.
    await agent.message(task, { findings: review.findings });
    return gate.retry();
  });

  if (!passed) {
    return notify(\`Gave up on "\${task.title}" after 5 reviews.\`, { importance: "urgent" });
  }

  await tool("GitHub", "waitForChecks", { pr: task.pr });
  await tool("GitHub", "markReadyForReview", { pr: task.pr });
  await notify(\`\${task.title} is reviewed, green, and ready.\`);
}
`;

const nodes: WorkflowNode[] = [
  {
    id: "done",
    title: "Task marked done",
    x: 0,
    y: 20,
    config: {
      kind: "trigger",
      source: "hook",
      hook: "task.markedDone",
      mode: "async",
      scope: "Tasks in t3code",
    },
  },
  {
    id: "opened",
    title: "Pull request opened",
    x: 0,
    y: 160,
    config: {
      kind: "trigger",
      source: "webhook",
      method: "POST",
      path: "/hooks/github",
      event: "pull_request.opened",
    },
  },
  {
    id: "review",
    title: "Claude reviews Codex's diff",
    x: 340,
    y: 90,
    config: {
      kind: "agent",
      provider: "claudeAgent",
      providerLabel: "Claude Code",
      model: "Claude Opus 5.5",
      project: "t3code",
      prompt:
        "Review this diff against the request and AGENTS.md. Report only real defects: behavior the request didn't ask for, regressions in touched code, missing tests for changed behavior.",
    },
  },
  {
    id: "verdict",
    title: "Review passes?",
    x: 640,
    y: 90,
    config: {
      kind: "judge",
      model: "Claude Haiku 5",
      question: "Does the review leave blocking findings?",
      outcomes: [
        { key: "pass", label: "Passes" },
        { key: "findings", label: "Has findings" },
      ],
    },
  },
  {
    id: "ci",
    title: "Wait for CI checks",
    x: 940,
    y: 0,
    config: {
      kind: "tool",
      integration: "GitHub",
      action: "Wait for checks",
      params: { pr: "{{task.pr}}", timeoutMinutes: 30 },
    },
  },
  {
    id: "ready",
    title: "Mark the PR ready",
    x: 1240,
    y: 0,
    config: {
      kind: "tool",
      integration: "GitHub",
      action: "Mark ready for review",
      params: { pr: "{{task.pr}}" },
    },
  },
  {
    id: "notify",
    title: "Tell me it's ready",
    x: 1540,
    y: 0,
    config: {
      kind: "notify",
      importance: "normal",
      message: "{{task.title}} is reviewed, green, and ready.",
    },
  },
  {
    id: "fix",
    title: "Codex fixes the findings",
    x: 940,
    y: 200,
    config: {
      kind: "agent",
      provider: "codex",
      providerLabel: "Codex",
      model: "gpt-6-astra",
      project: "t3code",
      opens: "The original Task, as a new message",
      unawareOfWorkflow: true,
      prompt: "Review findings on your change:\n{{review.findings}}",
    },
  },
  {
    id: "retry",
    title: "Review again?",
    x: 1240,
    y: 200,
    config: { kind: "gate", maxIterations: 5, retryLabel: "Try again", exitLabel: "Give up" },
  },
  {
    id: "handback",
    title: "Hand it back to me",
    x: 1540,
    y: 260,
    config: {
      kind: "notify",
      importance: "urgent",
      message: 'Gave up on "{{task.title}}" after 5 reviews.',
    },
  },
];

const passed = (durationMs: number, summary = "No findings"): RunIteration => ({
  status: "success",
  findings: 0,
  summary,
  durationMs,
});
const found = (findings: number, summary: string, durationMs: number): RunIteration => ({
  status: "failed",
  findings,
  summary,
  durationMs,
});

function shipRun(
  id: string,
  hoursBack: number,
  title: string,
  iterations: readonly RunIteration[],
  outcome: "shipped" | "reviewing" | "gave-up",
) {
  const last = iterations.at(-1);
  const loops = outcome === "gave-up" ? iterations.length : iterations.length - 1;
  const base = run(
    `ship-${id}`,
    title,
    hoursAgo(hoursBack),
    {
      done: ok(2, { task: title }),
      opened: skipped,
      review:
        outcome === "reviewing"
          ? { status: "running" }
          : ok(last?.durationMs ?? 0, { iteration: iterations.length, findings: last?.findings }),
      ...(outcome === "reviewing"
        ? {}
        : {
            verdict: ok(900, { branch: outcome === "shipped" ? "pass" : "findings" }),
            fix: loops > 0 ? ok(loops * 180_000, { messagesSent: loops }) : skipped,
            retry:
              loops > 0
                ? ok(1, { branch: outcome === "gave-up" ? "false" : "true", iteration: loops })
                : skipped,
            ci: outcome === "shipped" ? ok(420_000, { checks: "12 passed" }) : skipped,
            ready: outcome === "shipped" ? ok(1_100) : skipped,
            notify: outcome === "shipped" ? ok(200, { routedTo: "laptop badge" }) : skipped,
            handback: outcome === "gave-up" ? ok(200, { routedTo: "phone push" }) : skipped,
          }),
    },
    "hook",
  );
  // Giving up hands the work back, so the run needs you like a failure does.
  return { ...base, status: outcome === "gave-up" ? ("failed" as const) : base.status, iterations };
}

export const SHIP_CHANGE: Automation = {
  id: "ship-change",
  name: "Ship a change (review loop)",
  description:
    "Every finished Task gets reviewed by a different harness and sent back until it's actually good.",
  agentName: "Review loop agent",
  section: "personal",
  cadence: "On Task marked done or PR opened",
  enabled: true,
  nextRunAt: null,
  source: { path: "automations/ship-change.ts", code: SOURCE },
  nodes,
  edges: [
    { from: "done", to: "review" },
    { from: "opened", to: "review" },
    { from: "review", to: "verdict" },
    { from: "verdict", to: "ci", branch: "pass" },
    { from: "verdict", to: "fix", branch: "findings", retry: true },
    { from: "fix", to: "retry", retry: true },
    { from: "retry", to: "review", branch: "true", loop: true },
    { from: "retry", to: "handback", branch: "false" },
    { from: "ci", to: "ready" },
    { from: "ready", to: "notify" },
  ],
  runs: [
    shipRun(
      "a",
      0.2,
      "Reviewing: pin composer to the bottom",
      [
        found(2, "Scroll position resets on send; no test for the pinned state", 140_000),
        { status: "running", findings: 0, summary: "Reviewing the second attempt" },
      ],
      "reviewing",
    ),
    shipRun(
      "b",
      3,
      "Shipped after 3 iterations: diff file names clip",
      [
        found(3, "Clipping still happens in the split view; no test; unrelated rename", 162_000),
        found(1, "Split view fixed, but the test asserts markup instead of behavior", 118_000),
        passed(96_000),
      ],
      "shipped",
    ),
    shipRun("c", 26, "Shipped first try: multi-PR badges", [passed(88_000)], "shipped"),
    shipRun(
      "d",
      50,
      "Gave up after 5 iterations: Grok session recovery",
      [
        found(4, "Crash loop not reproduced; retries unbounded", 150_000),
        found(3, "Retries bounded, but the session state leaks", 140_000),
        found(2, "State leak fixed; new race on reconnect", 131_000),
        found(2, "Race still possible when two turns start together", 127_000),
        found(2, "Same race, different place", 125_000),
      ],
      "gave-up",
    ),
  ],
};
