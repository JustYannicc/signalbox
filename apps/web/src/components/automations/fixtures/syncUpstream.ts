/** PLACEHOLDER DATA: see automationFixtures.ts. */
import type { Automation, WorkflowNode } from "../automationModel";
import { lastDailyAt, shiftDays, ok, failed, skipped, run } from "./fixtureHelpers";

const syncNodes: WorkflowNode[] = [
  {
    id: "trigger",
    title: "Every day at 3:00 AM",
    x: 0,
    y: 90,
    config: {
      kind: "trigger",
      source: "schedule",
      cron: "0 3 * * *",
      timezone: "Europe/Zurich",
      summary: "Daily at 3:00 AM",
    },
  },
  {
    id: "compare",
    title: "Check upstream for new commits",
    x: 300,
    y: 90,
    config: {
      kind: "tool",
      integration: "GitHub",
      action: "Compare branches",
      params: { repository: "JustYannicc/t3code", base: "main", head: "pingdotgg/t3code:main" },
    },
  },
  {
    id: "changed",
    title: "Upstream moved?",
    x: 600,
    y: 90,
    config: {
      kind: "condition",
      expression: "compare.behind_by > 0",
      trueLabel: "New commits",
      falseLabel: "Up to date",
    },
  },
  {
    id: "merge",
    title: "Merge upstream into the fork",
    x: 900,
    y: 0,
    config: {
      kind: "agent",
      provider: "codex",
      providerLabel: "Codex",
      model: "gpt-6-astra",
      project: "t3code",
      prompt:
        "Merge pingdotgg/t3code main into this fork's main in an isolated worktree. Keep the fork section of AGENTS.md. Run focused typecheck and tests for anything the merge touched. Push only when checks pass; otherwise leave the worktree recoverable and explain the blocker.",
    },
  },
  {
    id: "push",
    title: "Push merged main",
    x: 1200,
    y: 0,
    config: {
      kind: "tool",
      integration: "GitHub",
      action: "Push branch",
      params: { remote: "origin", branch: "main", force: false },
    },
  },
  {
    id: "notify",
    title: "Post sync summary",
    x: 1500,
    y: 90,
    config: {
      kind: "tool",
      integration: "Slack",
      action: "Post message",
      params: {
        channel: "#t3code-fork",
        text: "{{merge.summary ?? 'Fork is already up to date.'}}",
      },
    },
  },
];

function syncRun(daysBack: number, outcome: "merged" | "noop" | "conflict", commits = 0) {
  const startedAt = shiftDays(lastDailyAt(3), -daysBack);
  const compare = ok(840, { behind_by: commits, ahead_by: 9 }, { base: "main" });
  const title =
    outcome === "merged"
      ? `Merged ${commits} upstream commits`
      : outcome === "noop"
        ? "Already up to date"
        : "Merge conflict in AGENTS.md";
  return run(`sync-${daysBack}`, title, startedAt, {
    trigger: ok(3, { firedAt: startedAt.toISOString() }),
    compare,
    changed: ok(2, { branch: outcome === "noop" ? "false" : "true" }),
    merge:
      outcome === "noop"
        ? skipped
        : outcome === "conflict"
          ? failed(
              248_000,
              "Conflict in AGENTS.md: upstream rewrote the section the fork keeps. Merge left in worktree t3code-sync for review.",
              { commits },
            )
          : ok(372_000, {
              mergedCommits: commits,
              conflicts: 0,
              checks: "typecheck, lint, 38 tests",
            }),
    push: outcome === "merged" ? ok(2_100, { head: "53de792f13", pushed: true }) : skipped,
    notify:
      outcome === "conflict" ? skipped : ok(380, { channel: "#t3code-fork", ts: "1727665200.1" }),
  });
}

const SOURCE = `import { agent, tool } from "@signalbox/automations";
import { schedule } from "@signalbox/automations/triggers";

export const trigger = schedule("0 3 * * *", { timezone: "Europe/Zurich" });

export async function syncUpstream() {
  "use workflow";

  const compare = await tool("GitHub", "compareBranches", {
    repository: "JustYannicc/t3code",
    base: "main",
    head: "pingdotgg/t3code:main",
  });

  if (compare.behind_by === 0) {
    return tool("Slack", "postMessage", {
      channel: "#t3code-fork",
      text: "Fork is already up to date.",
    });
  }

  const merge = await agent("codex", {
    model: "gpt-6-astra",
    project: "t3code",
    prompt: \`Merge pingdotgg/t3code main into this fork's main in an isolated
      worktree. Keep the fork section of AGENTS.md. Push only when checks pass.\`,
  });

  await tool("GitHub", "pushBranch", { remote: "origin", branch: "main" });
  await tool("Slack", "postMessage", { channel: "#t3code-fork", text: merge.summary });
}
`;

export const SYNC_UPSTREAM: Automation = {
  id: "sync-upstream",
  name: "Sync T3 Code upstream nightly",
  description: "Merges pingdotgg/t3code into the fork and pushes when checks pass.",
  agentName: "Upstream sync agent",
  section: "personal",
  cadence: "Daily at 3:00 AM",
  enabled: true,
  nextRunAt: shiftDays(lastDailyAt(3), 1).toISOString(),
  source: { path: "automations/sync-upstream.ts", code: SOURCE },
  nodes: syncNodes,
  edges: [
    { from: "trigger", to: "compare" },
    { from: "compare", to: "changed" },
    { from: "changed", to: "merge", branch: "true" },
    { from: "changed", to: "notify", branch: "false" },
    { from: "merge", to: "push" },
    { from: "push", to: "notify" },
  ],
  runs: [
    syncRun(0, "merged", 14),
    syncRun(1, "noop"),
    syncRun(2, "conflict", 31),
    syncRun(3, "merged", 6),
    syncRun(4, "merged", 21),
    syncRun(5, "noop"),
    syncRun(6, "merged", 3),
  ],
};
