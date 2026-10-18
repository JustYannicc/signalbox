const { setTimeout } = require("node:timers/promises");

module.exports = async function cancelPreviewDeploys({
  github,
  context,
  core,
  prNumber,
  wait = () => setTimeout(5_000),
  maxAttempts = 60,
}) {
  const pullNumber = Number(prNumber);
  if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) {
    throw new Error("A positive PR number is required before cancelling preview deploys.");
  }
  const { owner, repo } = context.repo;
  const repository = `${owner}/${repo}`;
  const { data: pull } = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });
  if (pull.head.repo?.full_name !== repository) {
    throw new Error("Preview teardown only cancels same-repository deploys.");
  }

  const requested = new Set();
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    // Cancelling only the deploy job misses pipelines still building their Runner image.
    const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
      owner,
      repo,
      workflow_id: "deploy-cloud.yml",
      event: "pull_request",
      branch: pull.head.ref,
      per_page: 100,
    });
    const active = runs.filter(
      (run) =>
        run.status !== "completed" &&
        run.event === "pull_request" &&
        run.head_branch === pull.head.ref &&
        run.head_repository?.full_name === repository &&
        // GitHub can omit PR associations; the exact same-repo branch remains scoped.
        (!run.pull_requests?.length || run.pull_requests.some((pr) => pr.number === pullNumber)),
    );
    if (active.length === 0) {
      core.info(`All preview deploys for PR #${pullNumber} have stopped.`);
      return;
    }
    for (const run of active) {
      if (requested.has(run.id)) continue;
      core.info(`Cancelling preview deploy run ${run.id} for PR #${pullNumber}.`);
      try {
        await github.rest.actions.cancelWorkflowRun({ owner, repo, run_id: run.id });
      } catch (error) {
        if (error.status !== 409) throw error;
        const current = await github.rest.actions.getWorkflowRun({ owner, repo, run_id: run.id });
        if (current.data.status !== "completed") throw error;
      }
      requested.add(run.id);
    }
    await wait();
  }
  throw new Error(`Preview deploys for PR #${pullNumber} did not stop; refusing teardown.`);
};
