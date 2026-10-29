import * as NodeAssert from "node:assert/strict";
import * as TestCase from "vite-plus/test";
import { cleanupDeploy3Worker } from "./cloudflare.ts";
import { createDeploy3Name } from "./deadline.ts";

const ACCOUNT = "a".repeat(32);
const ORIGINAL_DEADLINE = 2_000_000_000_000;
const WORKER = createDeploy3Name({
  runId: "a1b2c3d4",
  deadlineMs: ORIGINAL_DEADLINE,
  role: "workload",
});
const EXTENSION = "sb1070-d3-deadline-2000003600";
const EXPECTED_TAG = "worker-resource-tag";

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

function fixture(
  options: {
    readonly tags?: unknown;
    readonly failNamespacePage2?: boolean;
    readonly failWorkerDelete?: boolean;
    readonly failTailDelete?: boolean;
    readonly failWorkerPage2?: boolean;
  } = {},
) {
  const state = {
    workers: [
      {
        id: "unrelated-production-worker",
        tag: "unrelated-tag",
        etag: "other",
        tags: ["team:prod"],
      },
      { id: WORKER, tag: EXPECTED_TAG, etag: "etag-1", tags: options.tags ?? [EXTENSION] },
    ],
    namespaces: [
      { id: "shared-namespace", script: "another-worker" },
      { id: "deploy3-namespace", script: WORKER },
    ],
    tails: new Map<string, Record<string, unknown>>([
      [
        WORKER,
        { id: "tail-deploy3", expires_at: "2033-05-18T04:00:00.000Z", url: "wss://tail.invalid" },
      ],
    ]),
    calls: [] as { method: string; path: string; search: string }[],
    events: [] as string[],
    assetsPresent: true,
    failNamespacePage2: options.failNamespacePage2 ?? false,
    failWorkerDelete: options.failWorkerDelete ?? false,
    failTailDelete: options.failTailDelete ?? false,
    failWorkerPage2: options.failWorkerPage2 ?? false,
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const path = url.pathname.replace("/client/v4/accounts/" + ACCOUNT, "");
    const method = init?.method ?? "GET";
    state.calls.push({ method, path, search: url.search });
    state.events.push("dispatch:" + method + ":" + path);

    if (path === "/workers/scripts" && method === "GET") {
      const page = Number(url.searchParams.get("page") ?? 1);
      if (page === 2 && state.failWorkerPage2) return json({}, 500);
      const rows = page === 1 ? state.workers.slice(0, 1) : state.workers.slice(1);
      return json(rows, 200, 2);
    }
    if (path === "/workers/scripts/" + WORKER + "/settings" && method === "GET") {
      const worker = state.workers.find((item) => item.id === WORKER);
      if (!worker) return json({}, 404);
      return json({
        tags: worker.tags,
        bindings: [
          { type: "durable_object_namespace", name: "OWNED", namespace_id: "deploy3-namespace" },
          { type: "durable_object_namespace", name: "SHARED", namespace_id: "shared-namespace" },
          { type: "r2_bucket", name: "SHARED_BUCKET", bucket_name: "do-not-touch" },
          { type: "kv_namespace", name: "SHARED_KV", namespace_id: "do-not-touch" },
        ],
      });
    }
    if (path === "/workers/scripts/" + WORKER + "/tails" && method === "GET") {
      const tail = state.tails.get(WORKER);
      return state.workers.some((item) => item.id === WORKER) ? json(tail ?? null) : json({}, 404);
    }
    if (path === "/workers/scripts/" + WORKER + "/tails/tail-deploy3" && method === "DELETE") {
      if (state.failTailDelete) return json({}, 503);
      state.tails.delete(WORKER);
      return json({});
    }
    if (path === "/workers/scripts/" + WORKER && method === "DELETE") {
      if (state.failWorkerDelete) return json({}, 503);
      state.workers = state.workers.filter((item) => item.id !== WORKER);
      state.namespaces = state.namespaces.filter((item) => item.script !== WORKER);
      state.tails.delete(WORKER);
      state.assetsPresent = false;
      return json({});
    }
    if (path === "/workers/durable_objects/namespaces" && method === "GET") {
      const page = Number(url.searchParams.get("page") ?? 1);
      if (page === 2 && state.failNamespacePage2) return json({}, 503);
      const rows = page === 1 ? state.namespaces.slice(0, 1) : state.namespaces.slice(1);
      return json(rows, 200, 2);
    }
    return json({}, 404);
  };

  const observe = async (event: { type: string; key: string }) => {
    state.events.push("journal:" + event.type + ":" + event.key);
  };
  return { state, fetchImpl, observe };
}

TestCase.test(
  "deletes only the due deploy3 Tail and Worker, then verifies account-wide namespace absence",
  async () => {
    const { state, fetchImpl, observe } = fixture();
    const result = await cleanupDeploy3Worker({
      accountId: ACCOUNT,
      token: "offline-test-token",
      workerName: WORKER,
      expectedTag: EXPECTED_TAG,
      nowMs: 2_000_003_601_000,
      fetchImpl,
      observe,
    });

    NodeAssert.equal(result.status, "verified-absent");
    NodeAssert.equal(result.cleanClaim, true);
    NodeAssert.equal(result.assets, "worker-script-managed");
    NodeAssert.equal(
      state.workers.some((item) => item.id === WORKER),
      false,
    );
    NodeAssert.equal(
      state.namespaces.some((item) => item.script === WORKER),
      false,
    );
    NodeAssert.equal(
      state.namespaces.some((item) => item.id === "shared-namespace"),
      true,
    );
    NodeAssert.equal(state.assetsPresent, false);
    NodeAssert.deepEqual(
      state.calls.filter((call) => call.method === "DELETE").map((call) => call.path),
      ["/workers/scripts/" + WORKER + "/tails/tail-deploy3", "/workers/scripts/" + WORKER],
    );
    NodeAssert.equal(
      state.calls.some((call) => call.search.includes("force=true")),
      false,
    );
    NodeAssert.equal(
      state.calls.some((call) => call.path.includes("/r2/") || call.path.includes("/kv/")),
      false,
    );
    NodeAssert.equal(
      state.calls.some(
        (call) => call.method === "DELETE" && call.path.includes("/durable_objects/namespaces/"),
      ),
      false,
    );
    NodeAssert.deepEqual(result.externalBindingsPreserved, [
      "durable_object_namespace:shared-namespace",
      "kv_namespace:SHARED_KV",
      "r2_bucket:SHARED_BUCKET",
    ]);
    for (const call of state.calls.filter((item) => item.method === "DELETE")) {
      const dispatch = state.events.indexOf("dispatch:DELETE:" + call.path);
      NodeAssert.notEqual(dispatch, -1);
      NodeAssert.match(
        state.events[dispatch - 1] ?? "",
        /^journal:cloudflare-mutation-started:delete-/,
      );
    }
    NodeAssert.equal(JSON.stringify(result).includes("offline-test-token"), false);
  },
);

TestCase.test(
  "invalid names, future deadlines, malformed tags, and changed Worker tags never mutate",
  async () => {
    const invalidName = fixture();
    const invalid = await cleanupDeploy3Worker({
      accountId: ACCOUNT,
      token: "offline-test-token",
      workerName: "sb1070-d3-not-a-valid-name",
      nowMs: 3_000_000_000_000,
      fetchImpl: invalidName.fetchImpl,
    });
    NodeAssert.equal(invalid.cleanClaim, false);
    NodeAssert.equal(invalidName.state.calls.length, 0);

    const future = fixture({ tags: ["sb1070-d3-deadline-2000007200"] });
    const notDue = await cleanupDeploy3Worker({
      accountId: ACCOUNT,
      token: "offline-test-token",
      workerName: WORKER,
      nowMs: 2_000_003_601_000,
      fetchImpl: future.fetchImpl,
    });
    NodeAssert.equal(notDue.status, "not-due");
    NodeAssert.equal(
      future.state.calls.some((call) => call.method === "DELETE"),
      false,
    );

    const malformed = fixture({ tags: ["sb1070-d3-deadline-nope"] });
    const badTag = await cleanupDeploy3Worker({
      accountId: ACCOUNT,
      token: "offline-test-token",
      workerName: WORKER,
      nowMs: 3_000_000_000_000,
      fetchImpl: malformed.fetchImpl,
    });
    NodeAssert.equal(badTag.cleanClaim, false);
    NodeAssert.equal(
      malformed.state.calls.some((call) => call.method === "DELETE"),
      false,
    );

    const changed = fixture();
    const mismatch = await cleanupDeploy3Worker({
      accountId: ACCOUNT,
      token: "offline-test-token",
      workerName: WORKER,
      expectedTag: "different-immutable-tag",
      nowMs: 3_000_000_000_000,
      fetchImpl: changed.fetchImpl,
    });
    NodeAssert.equal(mismatch.status, "refused");
    NodeAssert.equal(
      changed.state.calls.some((call) => call.method === "DELETE"),
      false,
    );
  },
);

TestCase.test("an incomplete namespace page blocks every mutation", async () => {
  const { state, fetchImpl } = fixture({ failNamespacePage2: true });
  const result = await cleanupDeploy3Worker({
    accountId: ACCOUNT,
    token: "offline-test-token",
    workerName: WORKER,
    nowMs: 3_000_000_000_000,
    fetchImpl,
  });
  NodeAssert.equal(result.cleanClaim, false);
  NodeAssert.equal(
    state.calls.some((call) => call.method === "DELETE"),
    false,
  );
});

TestCase.test("a partial API failure never produces a clean claim", async () => {
  const { state, fetchImpl } = fixture({ failWorkerDelete: true });
  const result = await cleanupDeploy3Worker({
    accountId: ACCOUNT,
    token: "offline-test-token",
    workerName: WORKER,
    nowMs: 3_000_000_000_000,
    fetchImpl,
  });
  NodeAssert.equal(result.status, "failed-or-uncertain");
  NodeAssert.equal(result.cleanClaim, false);
  NodeAssert.equal(
    state.workers.some((item) => item.id === WORKER),
    true,
  );
  NodeAssert.ok(result.failures.includes("delete-worker"));
  NodeAssert.ok(result.failures.includes("verify-worker-absence"));
  NodeAssert.ok(result.failures.includes("verify-namespace-absence"));
});

TestCase.test("an incomplete Worker page and an oversized response block cleanup", async () => {
  const pages = fixture({ failWorkerPage2: true });
  const incomplete = await cleanupDeploy3Worker({
    accountId: ACCOUNT,
    token: "offline-test-token",
    workerName: WORKER,
    nowMs: 3_000_000_000_000,
    fetchImpl: pages.fetchImpl,
  });
  NodeAssert.equal(incomplete.cleanClaim, false);
  NodeAssert.equal(
    pages.state.calls.some((call) => call.method === "DELETE"),
    false,
  );

  const oversizedFetch: typeof fetch = async () =>
    new Response(new Uint8Array(2 * 1024 * 1024 + 1), { status: 200 });
  const oversized = await cleanupDeploy3Worker({
    accountId: ACCOUNT,
    token: "offline-test-token",
    workerName: WORKER,
    nowMs: 3_000_000_000_000,
    fetchImpl: oversizedFetch,
  });
  NodeAssert.equal(oversized.cleanClaim, false);
  NodeAssert.ok(oversized.failures.includes("worker-inventory-incomplete"));
});

TestCase.test(
  "a Tail API failure stays visible even when Worker deletion removes the remaining Tail",
  async () => {
    const { state, fetchImpl } = fixture({ failTailDelete: true });
    const result = await cleanupDeploy3Worker({
      accountId: ACCOUNT,
      token: "offline-test-token",
      workerName: WORKER,
      nowMs: 3_000_000_000_000,
      fetchImpl,
    });
    NodeAssert.equal(result.status, "failed-or-uncertain");
    NodeAssert.equal(result.cleanClaim, false);
    NodeAssert.equal(
      state.workers.some((item) => item.id === WORKER),
      false,
    );
    NodeAssert.ok(result.failures.includes("delete-tail:tail-deploy3"));
    NodeAssert.ok(
      result.checks.some((item) => item.name === "verify-tail-absence" && item.status === "passed"),
    );
  },
);
