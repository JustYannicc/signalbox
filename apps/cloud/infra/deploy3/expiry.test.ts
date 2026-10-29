import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { deploy3BootstrapIdentity, deploy3CleanupToken, deploy3Expiry } from "./expiry.ts";

const start = Date.parse("2026-10-29T12:00:00.000Z");
const receipt = {
  workerName: deploy3BootstrapIdentity("deadbeef", start).workerName,
  workerId: "a".repeat(32),
  receivedAtUtc: "2026-10-29T12:00:03.456Z",
  responseSha256: "b".repeat(64),
  bundleSha256: "c".repeat(64),
};

NodeTest.test("cleanup token expires two hours after the receipt-bound 24h deadline", () => {
  const expiry = deploy3Expiry(receipt);
  NodeAssert.equal(expiry.deadlineUtc, "2026-10-30T12:00:03.456Z");
  const token = deploy3CleanupToken(receipt);
  NodeAssert.equal(token.expiresOn, "2026-10-30T14:00:03.456Z");
  NodeAssert.deepEqual(token.policies[0]!.resources, {
    [`com.cloudflare.edge.worker.script.${receipt.workerId}`]: "*",
  });
  NodeAssert.equal(
    deploy3BootstrapIdentity("deadbeef", start).operatorTokenExpiresOn,
    "2026-10-29T12:45:00.000Z",
  );
});

NodeTest.test("arming rejects a later name deadline and invalid receipt identity", () => {
  NodeAssert.throws(() => deploy3Expiry({ ...receipt, workerId: "*" }));
  NodeAssert.throws(() => deploy3Expiry({ ...receipt, responseSha256: "missing" }));
  NodeAssert.throws(() => deploy3Expiry({ ...receipt, receivedAtUtc: "2026-10-28T12:00:00.000Z" }));
});

NodeTest.test(
  "only a written coordinator extension moves the deadline and token expiry together",
  () => {
    const extension = {
      coordinatorThreadId: "mcp:ba538951-e7df-4b6b-b0d2-53a5dcd22bac",
      sourceMessageId: "message:actual-coordinator-extension",
      fullText: "Keep this exact deployment until 2026-10-31T12:00:00.000Z.",
      deadlineUtc: "2026-10-31T12:00:00.000Z",
    };
    const expiry = deploy3Expiry({ ...receipt, extension });
    NodeAssert.equal(expiry.originalDeadlineUtc, "2026-10-30T12:00:03.456Z");
    NodeAssert.equal(expiry.deadlineUtc, extension.deadlineUtc);
    NodeAssert.equal(
      deploy3CleanupToken({ ...receipt, extension }).expiresOn,
      "2026-10-31T14:00:00.000Z",
    );
    NodeAssert.throws(() =>
      deploy3Expiry({ ...receipt, extension: { ...extension, fullText: "" } }),
    );
    NodeAssert.throws(() =>
      deploy3Expiry({
        ...receipt,
        extension: { ...extension, coordinatorThreadId: "another-agent" },
      }),
    );
  },
);
