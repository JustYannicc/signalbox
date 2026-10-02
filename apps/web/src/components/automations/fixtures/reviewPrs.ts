/** PLACEHOLDER DATA: see automationFixtures.ts. */
import type { Automation, WorkflowNode } from "../automationModel";
import { NOW, HOUR, ok, failed, skipped, run } from "./fixtureHelpers";

const reviewNodes: WorkflowNode[] = [
  {
    id: "trigger",
    title: "Pull request opened",
    x: 0,
    y: 90,
    config: {
      kind: "trigger",
      source: "webhook",
      method: "POST",
      path: "/hooks/github",
      event: "pull_request.opened",
    },
  },
  {
    id: "bot",
    title: "Opened by a bot?",
    x: 300,
    y: 90,
    config: {
      kind: "condition",
      expression: 'pr.user.type == "Bot"',
      trueLabel: "Bot",
      falseLabel: "Human",
    },
  },
  {
    id: "label",
    title: "Label dependency bumps",
    x: 600,
    y: 0,
    config: {
      kind: "tool",
      integration: "GitHub",
      action: "Add labels",
      params: { labels: ["dependencies"] },
    },
  },
  {
    id: "review",
    title: "Review the pull request",
    x: 600,
    y: 180,
    config: {
      kind: "agent",
      provider: "codex",
      providerLabel: "Codex",
      model: "gpt-6-astra",
      project: "t3code",
      prompt:
        "Review the diff against AGENTS.md. Report only real defects with file and line, and say plainly when there are none.",
    },
  },
  {
    id: "post",
    title: "Post the review",
    x: 900,
    y: 180,
    config: {
      kind: "tool",
      integration: "GitHub",
      action: "Create review",
      params: { event: "COMMENT" },
    },
  },
];

function reviewRun(hoursBack: number, pr: string, kind: "bot" | "human" | "timeout") {
  const title =
    kind === "bot"
      ? `Labeled ${pr}`
      : kind === "timeout"
        ? `Review timed out on ${pr}`
        : `Reviewed ${pr}`;
  return run(
    `review-${hoursBack}`,
    title,
    new Date(NOW.getTime() - hoursBack * HOUR),
    {
      trigger: ok(5, { action: "opened", number: pr }),
      bot: ok(1, { branch: kind === "bot" ? "true" : "false" }),
      label: kind === "bot" ? ok(520, { labels: ["dependencies"] }) : skipped,
      review:
        kind === "bot"
          ? skipped
          : kind === "timeout"
            ? failed(1_800_000, "No result after 30 minutes.")
            : ok(163_000, { findings: 1 }),
      post: kind === "human" ? ok(700, { reviewId: 2291 }) : skipped,
    },
    "webhook",
  );
}

const SOURCE = `import { agent, tool } from "@signalbox/automations";
import { webhook } from "@signalbox/automations/triggers";

export const trigger = webhook("POST", "/hooks/github", { event: "pull_request.opened" });

export async function reviewPullRequest({ pr }: { pr: PullRequest }) {
  "use workflow";

  if (pr.user.type === "Bot") {
    return tool("GitHub", "addLabels", { labels: ["dependencies"] });
  }

  const review = await agent("codex", {
    model: "gpt-6-astra",
    project: "t3code",
    timeout: "30m",
    prompt: \`Review the diff against AGENTS.md. Report only real defects with
      file and line, and say plainly when there are none.\`,
  });

  await tool("GitHub", "createReview", { event: "COMMENT", body: review.text });
}
`;

export const REVIEW_PRS: Automation = {
  id: "review-prs",
  name: "Review opened pull requests",
  description: "Labels bot PRs and gives human PRs a first-pass review.",
  agentName: "PR review agent",
  section: "personal",
  cadence: "On pull request opened",
  enabled: true,
  nextRunAt: null,
  source: { path: "automations/review-prs.ts", code: SOURCE },
  nodes: reviewNodes,
  edges: [
    { from: "trigger", to: "bot" },
    { from: "bot", to: "label", branch: "true" },
    { from: "bot", to: "review", branch: "false" },
    { from: "review", to: "post" },
  ],
  runs: [
    reviewRun(1.5, "#14375", "human"),
    reviewRun(5, "#14362", "bot"),
    reviewRun(20, "#13211", "human"),
    reviewRun(30, "#13190", "timeout"),
  ],
};
