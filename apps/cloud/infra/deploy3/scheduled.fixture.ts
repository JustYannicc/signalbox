import { deploy3BootstrapIdentity, deploy3Expiry } from "./expiry.ts";

export const fixtureReceipt = {
  workerName: deploy3BootstrapIdentity("deadbeef", Date.parse("2026-10-29T12:00:00.000Z"))
    .workerName,
  workerId: "a".repeat(32),
  receivedAtUtc: "2026-10-29T12:00:03.456Z",
  responseSha256: "b".repeat(64),
  bundleSha256: "c".repeat(64),
};
export const fixtureEnvironment = {
  DEPLOY3_ACCOUNT_ID: "a".repeat(32),
  DEPLOY3_CLEANUP_TOKEN: "offline-scoped-token",
  DEPLOY3_RECEIPT: fixtureReceipt,
};

/** A fake Cloudflare control plane; onDelete can remove real local workload bindings. */
export function scheduledControlPlane(onDelete: () => Promise<void> = async () => {}) {
  let present = true;
  let tail = true;
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname.split(
      `/accounts/${fixtureEnvironment.DEPLOY3_ACCOUNT_ID}`,
    )[1];
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);
    const workerPath = `/workers/scripts/${fixtureReceipt.workerName}`;
    const tags = [deploy3Expiry(fixtureReceipt).deadlineTag];
    const json = (result: unknown) => Response.json({ success: true, result });
    if (method === "GET" && path === "/workers/scripts") {
      return json(
        present ? [{ id: fixtureReceipt.workerName, tag: fixtureReceipt.workerId, tags }] : [],
      );
    }
    if (method === "GET" && path === workerPath + "/settings") {
      return json({
        tags,
        bindings: [{ type: "r2_bucket", name: "EVIDENCE", bucket_name: "retained-evidence" }],
      });
    }
    if (method === "GET" && path === "/workers/durable_objects/namespaces") {
      return json(present ? [{ id: "owned-namespace", script: fixtureReceipt.workerName }] : []);
    }
    if (method === "GET" && path === workerPath + "/tails")
      return json(present && tail ? { id: "owned-tail" } : null);
    if (method === "DELETE" && path === workerPath + "/tails/owned-tail") {
      tail = false;
      return json({});
    }
    if (method === "DELETE" && path === workerPath) {
      await onDelete();
      present = false;
      return json({});
    }
    throw new Error(`Unexpected fake Cloudflare request ${method} ${path}`);
  };
  return { fetchImpl, calls, present: () => present };
}
