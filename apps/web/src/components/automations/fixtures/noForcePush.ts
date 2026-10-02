/** PLACEHOLDER DATA: see automationFixtures.ts. */
import type { Automation, WorkflowNode } from "../automationModel";
import { hoursAgo, ok, run, skipped } from "./fixtureHelpers";

const SOURCE = `import { hook } from "@signalbox/automations/triggers";

// Inline: runs before any agent's shell command, so it stays plain code.
export const trigger = hook("tool.beforeCall", {
  inline: true,
  scope: { tools: ["shell"] },
  budget: "10ms",
});

const FORCE_PUSH_TO_MAIN = /git push .*(--force|-f)\\b.*\\bmain\\b/;

export async function noForcePushToMain({ call }: { call: ToolCall }) {
  "use workflow";

  if (!FORCE_PUSH_TO_MAIN.test(call.command)) return call.allow();

  return call.block({
    reason: "Force-pushing to main is blocked by a workflow. Push a branch and open a PR.",
  });
}
`;

const nodes: WorkflowNode[] = [
  {
    id: "trigger",
    title: "Before an agent runs a shell command",
    x: 0,
    y: 60,
    config: {
      kind: "trigger",
      source: "hook",
      hook: "tool.beforeCall",
      mode: "inline",
      scope: "All agents · shell tool",
      budget: "Adds ~5ms",
    },
  },
  {
    id: "check",
    title: "Force-push to main?",
    x: 300,
    y: 60,
    config: {
      kind: "condition",
      expression: "/git push .*(--force|-f)\\b.*\\bmain\\b/.test(call.command)",
      trueLabel: "Force-push",
      falseLabel: "Anything else",
    },
  },
  {
    id: "block",
    title: "Block and explain",
    x: 620,
    y: 0,
    config: {
      kind: "verdict",
      action: "block",
      effect:
        "The command never runs. The agent gets: 'Force-pushing to main is blocked by a workflow. Push a branch and open a PR.'",
    },
  },
  {
    id: "allow",
    title: "Run the command",
    x: 620,
    y: 130,
    config: {
      kind: "verdict",
      action: "allow",
      effect: "The command runs unchanged.",
    },
  },
];

/** Only blocked calls become runs; allowed ones only count. */
function pushRun(id: string, hoursBack: number, command: string, blocked: boolean) {
  return run(
    `push-${id}`,
    `${blocked ? "Blocked" : "Allowed"}: ${command}`,
    hoursAgo(hoursBack),
    {
      trigger: ok(1, { tool: "shell", command }),
      check: ok(1, { branch: blocked ? "true" : "false" }),
      block: blocked ? ok(1) : skipped,
      allow: blocked ? skipped : ok(1),
    },
    "hook",
  );
}

export const NO_FORCE_PUSH: Automation = {
  id: "no-force-push",
  name: "No force-push to main",
  description: "Stops any agent from force-pushing to main, whatever harness it runs in.",
  agentName: "Git guard agent",
  allowedToday: 1_843,
  cadence: "Before every shell command",
  enabled: true,
  nextRunAt: null,
  source: { path: "automations/no-force-push.ts", code: SOURCE },
  nodes,
  edges: [
    { from: "trigger", to: "check" },
    { from: "check", to: "block", branch: "true" },
    { from: "check", to: "allow", branch: "false" },
  ],
  runs: [
    pushRun("b", 0.7, "git push --force origin main", true),
    pushRun("e", 52, "git push -f origin main", true),
  ],
};
