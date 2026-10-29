import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { verifyDeploy3Arming } from "./arming.ts";
import { controlFixture, controlRegistration } from "./control.fixture.ts";

NodeTest.test(
  "arming reads actual runtime, immutable Worker, minute Cron and token expiry without a provider route",
  async () => {
    const fixture = controlFixture();
    const calls: string[] = [];
    let cron = "* * * * *";
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname === "/deployment-ready")
        return Response.json({
          runId: controlRegistration.runId,
          workerId: controlRegistration.workerId,
          deadlineUtc: controlRegistration.deadlineUtc,
          cleanupTokenId: controlRegistration.cleanupTokenId,
          cleanupTokenExpiresOn: controlRegistration.cleanupTokenExpiresOn,
          nativeStarted: false,
        });
      if (url.pathname.endsWith("/schedules"))
        return Response.json({ success: true, result: { schedules: [{ cron }] } });
      return fixture.fetchImpl(input, init);
    };
    const input = {
      registration: controlRegistration,
      origin: `https://${controlRegistration.workerName}.example.workers.dev`,
      accountId: fixture.env.DEPLOY3_ACCOUNT_ID,
      operatorToken: "expiring-operator",
      cleanupToken: "exact-cleanup",
      nowMs: Date.parse(controlRegistration.deadlineUtc) - 1_000,
      fetchImpl,
    };
    NodeAssert.equal((await verifyDeploy3Arming(input)).status, "armed-verified");
    NodeAssert.equal(
      calls.some((path) => path.includes("/turn") || path.includes("/ready/")),
      false,
    );
    cron = "0 * * * *";
    await NodeAssert.rejects(verifyDeploy3Arming(input), /minute Cron is not armed/);
    NodeAssert.deepEqual(
      fixture.cf.calls.filter((call) => call.startsWith("DELETE")),
      [],
    );
  },
);
