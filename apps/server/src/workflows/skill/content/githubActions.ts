import {
  GITHUB_ACTIONS_WORKFLOW,
  GITHUB_ACTIONS_WORKFLOW_PATH,
} from "@signalbox/automations/githubActionsWorkflow";

/** `references/github-actions.md`: installing the step workflow `w.run(…, { on: "github-actions" })` dispatches. */
export const GITHUB_ACTIONS = `# Steps on GitHub Actions

\`w.run(label, { on: "github-actions" }, fn, ...args)\` runs \`fn\` on the folder repository's GitHub Actions runners. Signalbox dispatches one workflow for it, which the repository needs on its default branch.

## Installing it

When a step fails with "doesn't have Signalbox's step workflow", or before saving the first automation that runs on GitHub Actions:

1. Add \`${GITHUB_ACTIONS_WORKFLOW_PATH}\` with exactly the content below on a new branch.
2. Open a pull request ("Let Signalbox automations run steps on GitHub Actions") and link it to your thread.
3. A person merges it. Don't merge it yourself: it lets automations run code with the repository's secrets.
4. Retry the failed run.

Don't edit the file: Signalbox dispatches it by name with these inputs and reads the \`signalbox-result\` artifact.

\`\`\`yaml
${GITHUB_ACTIONS_WORKFLOW}\`\`\`
`;
