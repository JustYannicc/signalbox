import * as NodeAssert from "node:assert/strict";
import * as TestCase from "vite-plus/test";
import { runDeploy3Sweep } from "./janitor.ts";
import { createDeploy3Name } from "./deadline.ts";

const ACCOUNT = "b".repeat(32);
const NOW = 3_000_000_000_000;
const EXPIRED = createDeploy3Name({
  runId: "11111111",
  deadlineMs: 2_000_000_000_000,
  role: "workload",
});
const FUTURE = createDeploy3Name({
  runId: "22222222",
  deadlineMs: 4_000_000_000_000,
  role: "workload",
});
const INVALID = "sb1070-d3-not-a-deploy3-name";

function json(result: unknown, status = 200, totalPages?: number): Response {
  return Response.json(
    {
      success: status < 400,
      result,
      ...(totalPages === undefined ? {} : { result_info: { total_pages: totalPages } }),
    },
    { status },
  );
}

function janitorTransport(failWorkerPage2 = false) {
  const state = {
    workers: [
      { id: "unrelated-worker", tag: "other", tags: [] as string[] },
      { id: EXPIRED, tag: "expired-tag", tags: [] as string[] },
      { id: FUTURE, tag: "future-tag", tags: [] as string[] },
      { id: INVALID, tag: "invalid-tag", tags: [] as string[] },
    ],
    deleted: [] as string[],
    calls: [] as { method: string; path: string }[],
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const path = url.pathname.replace("/client/v4/accounts/" + ACCOUNT, "");
    const method = init?.method ?? "GET";
    state.calls.push({ method, path });

    if (path === "/workers/scripts" && method === "GET") {
      const page = Number(url.searchParams.get("page") ?? 1);
      if (page === 2 && failWorkerPage2) return json({}, 500);
      return json(page === 1 ? state.workers.slice(0, 1) : state.workers.slice(1), 200, 2);
    }
    if (path === "/workers/scripts/" + EXPIRED + "/settings" && method === "GET") {
      return json({ tags: [], bindings: [] });
    }
    if (path === "/workers/scripts/" + EXPIRED + "/tails" && method === "GET") {
      return json(null);
    }
    if (path === "/workers/scripts/" + EXPIRED && method === "DELETE") {
      state.deleted.push(EXPIRED);
      state.workers = state.workers.filter((worker) => worker.id !== EXPIRED);
      return json({});
    }
    if (path === "/workers/durable_objects/namespaces" && method === "GET") {
      return json([], 200, 1);
    }
    return json({}, 404);
  };
  return { state, fetchImpl };
}

TestCase.test("hourly backstop deletes only expired, parseable deploy3 Workers", async () => {
  const { state, fetchImpl } = janitorTransport();
  const result = await runDeploy3Sweep({
    accountId: ACCOUNT,
    token: "offline-test-token",
    nowMs: NOW,
    fetchImpl,
  });

  NodeAssert.equal(result.scannedWorkers, 4);
  NodeAssert.equal(result.candidateWorkers, 3);
  NodeAssert.equal(result.expiredWorkers, 1);
  NodeAssert.equal(result.notDueWorkers, 1);
  NodeAssert.equal(result.status, "failed-or-uncertain");
  NodeAssert.equal(result.cleanClaim, false);
  NodeAssert.deepEqual(state.deleted, [EXPIRED]);
  NodeAssert.equal(
    state.workers.some((worker) => worker.id === FUTURE),
    true,
  );
  NodeAssert.equal(
    state.workers.some((worker) => worker.id === INVALID),
    true,
  );
  NodeAssert.ok(result.failures.some((failure) => failure.includes("invalid-deploy3-name")));
});

TestCase.test(
  "an incomplete account inventory produces evidence failure before any deletion",
  async () => {
    const { state, fetchImpl } = janitorTransport(true);
    const result = await runDeploy3Sweep({
      accountId: ACCOUNT,
      token: "offline-test-token",
      nowMs: NOW,
      fetchImpl,
    });
    NodeAssert.equal(result.cleanClaim, false);
    NodeAssert.deepEqual(result.failures, ["worker-inventory-incomplete"]);
    NodeAssert.deepEqual(state.deleted, []);
    NodeAssert.equal(
      state.calls.some((call) => call.method === "DELETE"),
      false,
    );
  },
);
