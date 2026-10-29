import { deploy3RegistryApi, RECEIPT_MARKER } from "./registryGitHub.ts";
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { deploy3PublicReceipt, formatDeploy3PublicReceipt } from "./teardownReceipt.ts";
import { cleanupDeploy3Worker } from "./cloudflare.ts";
import { fixtureEnvironment, fixtureReceipt, scheduledControlPlane } from "./scheduled.fixture.ts";
import { deploy3Expiry } from "./expiry.ts";

NodeTest.test(
  "public comments use only fixed receipt fields and never include a supplied payload",
  async () => {
    const api = scheduledControlPlane();
    const cleanup = await cleanupDeploy3Worker({
      accountId: fixtureEnvironment.DEPLOY3_ACCOUNT_ID,
      token: fixtureEnvironment.DEPLOY3_CLEANUP_TOKEN,
      workerName: fixtureReceipt.workerName,
      expectedTag: fixtureReceipt.workerId,
      nowMs: deploy3Expiry(fixtureReceipt).deadlineMs + 1_000,
      fetchImpl: api.fetchImpl,
    });
    const receipt = deploy3PublicReceipt({
      cleanup: {
        ...cleanup,
        checks: [
          ...cleanup.checks,
          { name: "payload-secret", status: "passed", detail: "private-payload" },
        ],
      },
      ownersNotReleased: ["1070"],
      tokenExpiry: "expiry-configured",
      tokenExpiresOn: deploy3Expiry(fixtureReceipt).tokenExpiresOn,
    });
    const body = formatDeploy3PublicReceipt(receipt);
    NodeAssert.equal(body.includes("private-payload"), false);
    NodeAssert.equal(body.includes(fixtureEnvironment.DEPLOY3_CLEANUP_TOKEN), false);
    NodeAssert.equal(body.includes("evidence not exported"), true);
    let sent = false;
    const registry = deploy3RegistryApi({
      token: async () => "offline-comment-token",
      trustedWriterIds: [101],
      fetchImpl: async (url, init) => {
        NodeAssert.equal(
          url,
          "https://api.github.com/repos/JustYannicc/signalbox/issues/1070/comments",
        );
        const sentBody = JSON.parse(String(init?.body)).body;
        NodeAssert.equal(sentBody, `${RECEIPT_MARKER}${"a".repeat(64)} -->\n${body}`);
        sent = true;
        return Response.json({ id: 99, user: { id: 101 }, body: sentBody }, { status: 201 });
      },
    });
    await registry.postReceipt("a".repeat(64), receipt);
    NodeAssert.equal(sent, true);
  },
);
