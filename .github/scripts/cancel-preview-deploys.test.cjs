const assert = require("node:assert/strict");
const { test } = require("node:test");
const cancelPreviewDeploys = require("./cancel-preview-deploys.cjs");

const run = (id, fields = {}) => ({
  id,
  status: "in_progress",
  event: "pull_request",
  head_branch: "feature/preview",
  head_repository: { full_name: "owner/repo" },
  pull_requests: [{ number: 964 }],
  ...fields,
});

function fixture(snapshots, { cancelError, headRepo = "owner/repo" } = {}) {
  const cancelled = [];
  const queries = [];
  let reads = 0;
  let waits = 0;
  const listWorkflowRuns = () => {};
  return {
    cancelled,
    queries,
    waits: () => waits,
    input: {
      prNumber: "964",
      context: { repo: { owner: "owner", repo: "repo" } },
      core: { info() {} },
      maxAttempts: 3,
      wait: async () => {
        waits += 1;
      },
      github: {
        paginate: async (method, query) => {
          assert.equal(method, listWorkflowRuns);
          queries.push(query);
          return snapshots[Math.min(reads++, snapshots.length - 1)];
        },
        rest: {
          pulls: {
            get: async () => ({
              data: { head: { ref: "feature/preview", repo: { full_name: headRepo } } },
            }),
          },
          actions: {
            listWorkflowRuns,
            cancelWorkflowRun: async ({ run_id }) => {
              cancelled.push(run_id);
              if (cancelError) throw cancelError;
            },
          },
        },
      },
    },
  };
}

test("stops queued and running pipelines, then waits for their completion before returning", async () => {
  const f = fixture([[run(1), run(2, { status: "queued" })], [run(1)], []]);
  await cancelPreviewDeploys(f.input);
  assert.deepEqual(f.cancelled, [1, 2]);
  assert.equal(f.waits(), 2);
  assert.equal(f.queries.length, 3);
  assert.deepEqual(f.queries[0], {
    owner: "owner",
    repo: "repo",
    workflow_id: "deploy-cloud.yml",
    event: "pull_request",
    branch: "feature/preview",
    per_page: 100,
  });
});

test("catches a newly visible pipeline while waiting and accepts missing PR associations", async () => {
  const f = fixture([[run(1)], [run(2, { pull_requests: [] })], []]);
  await cancelPreviewDeploys(f.input);
  assert.deepEqual(f.cancelled, [1, 2]);
});

test("leaves completed runs, other PRs, forks, branches and production untouched", async () => {
  const f = fixture([
    [
      run(1, { status: "completed" }),
      run(2, { pull_requests: [{ number: 991 }] }),
      run(3, { head_repository: { full_name: "fork/repo" } }),
      run(4, { head_branch: "other" }),
      run(5, { event: "push" }),
    ],
  ]);
  await cancelPreviewDeploys(f.input);
  assert.deepEqual(f.cancelled, []);
});

test("refuses teardown when cancellation does not finish", async () => {
  const f = fixture([[run(1)]]);
  await assert.rejects(cancelPreviewDeploys(f.input), /did not stop; refusing teardown/);
  assert.deepEqual(f.cancelled, [1]);
});

test("treats a cancellation conflict as a finishing run and waits for it to complete", async () => {
  const conflict = Object.assign(new Error("Conflict"), { status: 409 });
  const finished = fixture([[run(1)], [run(1)], []], { cancelError: conflict });
  await cancelPreviewDeploys(finished.input);
  assert.deepEqual(finished.cancelled, [1]);
  assert.equal(finished.waits(), 2);
  const stuck = fixture([[run(1)]], { cancelError: conflict });
  await assert.rejects(cancelPreviewDeploys(stuck.input), /did not stop; refusing teardown/);
});

test("fails closed on GitHub errors or an unsafe PR target", async () => {
  const forbidden = Object.assign(new Error("Forbidden"), { status: 403 });
  const f = fixture([[run(1)]], { cancelError: forbidden });
  await assert.rejects(cancelPreviewDeploys(f.input), forbidden);
  const fork = fixture([[]], { headRepo: "fork/repo" });
  await assert.rejects(cancelPreviewDeploys(fork.input), /same-repository/);
  assert.deepEqual(fork.queries, []);
  await assert.rejects(cancelPreviewDeploys({ ...f.input, prNumber: "bad" }), /positive PR/);
});
