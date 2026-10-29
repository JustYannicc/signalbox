import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { runDeploy3Deadline, requireDeploy3Armed } from "./runtime.ts";
import { runRegisteredDeploy3Backstop } from "./registryCleanup.ts";
import { extendDeploy3Control } from "./controlLifecycle.ts";
import { controlBody, controlDigest } from "./controlRegistry.ts";
import { controlFixture, controlRegistration } from "./control.fixture.ts";
import { fixtureReceipt } from "./scheduled.fixture.ts";
import { DEPLOY3_TOKEN_GRACE_MS } from "./expiry.ts";
import { isoAt } from "./platform.ts";

const deadline = Date.parse(controlRegistration.deadlineUtc);

NodeTest.test(
  "the actual scheduled entry deletes with held consumers; a new janitor posts after self-deletion",
  async () => {
    const fixture = controlFixture();
    const primary = await runDeploy3Deadline({
      env: fixture.env,
      nowMs: deadline + 1,
      fetchImpl: fixture.fetchImpl,
    });
    NodeAssert.equal(primary.status, "receipt-unconfirmed");
    NodeAssert.equal(fixture.cf.present(), false);
    NodeAssert.equal(fixture.comments.length, 1);
    const beforeExpiry = await runRegisteredDeploy3Backstop({
      registry: fixture.api(),
      accountId: fixture.env.DEPLOY3_ACCOUNT_ID,
      cloudflareToken: "ci-secret",
      nowMs: deadline + 1,
      fetchImpl: fixture.fetchImpl,
    });
    NodeAssert.equal(beforeExpiry.cleanClaim, true);
    const body = fixture.comments.at(-1)!.body;
    NodeAssert.match(body, /Durable Object namespace owned-namespace absent/);
    NodeAssert.match(body, /Tail owned-tail absent/);
    NodeAssert.match(body, /Owners not released: #1070, #1255/);
    NodeAssert.match(body, /Token expiry: expiry-configured/);
    NodeAssert.match(body, /evidence not exported$/);
    NodeAssert.equal(
      fixture
        .api()
        .receiptIsFinal(
          fixture.comments,
          (await fixture.api().read()).controls[0]!.registrationSha256,
        ),
      false,
    );
    fixture.expireToken();
    const afterExpiry = await runRegisteredDeploy3Backstop({
      registry: fixture.api(),
      accountId: fixture.env.DEPLOY3_ACCOUNT_ID,
      cloudflareToken: "ci-secret",
      nowMs: deadline + DEPLOY3_TOKEN_GRACE_MS,
      fetchImpl: fixture.fetchImpl,
    });
    NodeAssert.equal(afterExpiry.cleanClaim, true);
    NodeAssert.match(fixture.comments.at(-1)!.body, /Token expiry: expired-verified/);
    NodeAssert.equal(
      fixture
        .api()
        .receiptIsFinal(
          fixture.comments,
          (await fixture.api().read()).controls[0]!.registrationSha256,
        ),
      true,
    );
    NodeAssert.deepEqual(
      fixture.cf.calls.filter((call) => call.startsWith("DELETE")),
      [
        `DELETE /workers/scripts/${controlRegistration.workerName}/tails/owned-tail`,
        `DELETE /workers/scripts/${controlRegistration.workerName}`,
      ],
    );
  },
);

NodeTest.test(
  "GitHub outage cannot make an unreleased owner block the bound deadline",
  async () => {
    const fixture = controlFixture();
    fixture.failPublicRead();
    const result = await runDeploy3Deadline({
      env: fixture.env,
      nowMs: deadline + 1,
      fetchImpl: fixture.fetchImpl,
    });
    NodeAssert.equal(result.status, "receipt-unconfirmed");
    NodeAssert.equal(fixture.cf.present(), false);
  },
);

NodeTest.test(
  "written extension delays both primary and backstop without trusting stale Worker tags",
  async () => {
    const fixture = controlFixture();
    const extended = deadline + 3_600_000;
    fixture.comments.push({
      id: 2,
      user: { id: 101 },
      body: controlBody({
        kind: "extended",
        runId: "deadbeef",
        registrationSha256: await controlDigest(controlBody(controlRegistration)),
        deadlineUtc: isoAt(extended),
        cleanupTokenExpiresOn: isoAt(extended + DEPLOY3_TOKEN_GRACE_MS),
        coordinatorAuthoritySha256: "e".repeat(64),
      }),
    });
    const primary = await runDeploy3Deadline({
      env: fixture.env,
      nowMs: deadline + 1,
      fetchImpl: fixture.fetchImpl,
    });
    NodeAssert.equal(primary.status, "not-due");
    const result = await runRegisteredDeploy3Backstop({
      registry: fixture.api(),
      accountId: fixture.env.DEPLOY3_ACCOUNT_ID,
      cloudflareToken: "ci-secret",
      nowMs: deadline + 1,
      fetchImpl: fixture.fetchImpl,
    });
    NodeAssert.deepEqual(result.results, []);
    NodeAssert.equal(fixture.cf.present(), true);
  },
);

NodeTest.test("the native route gate rejects bootstrap and mismatched deadline identities", () => {
  const fixture = controlFixture();
  NodeAssert.throws(() => requireDeploy3Armed({}), /not armed/);
  NodeAssert.equal(
    requireDeploy3Armed(fixture.env).registration.workerId,
    controlRegistration.workerId,
  );
  NodeAssert.throws(
    () =>
      requireDeploy3Armed({
        ...fixture.env,
        DEPLOY3_CONTROL: JSON.stringify({
          ...controlRegistration,
          workerId: "f".repeat(32),
        }),
      }),
    /identities differ/,
  );
});

NodeTest.test(
  "the bound written extension still holds during a GitHub outage and expires at its replacement deadline",
  async () => {
    const fixture = controlFixture();
    const extended = deadline + 3_600_000;
    const receipt = {
      ...fixtureReceipt,
      extension: {
        coordinatorThreadId: "mcp:ba538951-e7df-4b6b-b0d2-53a5dcd22bac",
        sourceMessageId: "message:written-extension",
        fullText: "Extend this exact deployment by one hour.",
        deadlineUtc: isoAt(extended),
      },
    };
    fixture.setTokenExpiry(isoAt(extended + DEPLOY3_TOKEN_GRACE_MS));
    await extendDeploy3Control({
      api: fixture.api(),
      runId: "deadbeef",
      receipt,
      async verifyExtendedToken(value) {
        return value === isoAt(extended + DEPLOY3_TOKEN_GRACE_MS);
      },
    });
    fixture.failPublicRead();
    const env = { ...fixture.env, DEPLOY3_RECEIPT: receipt };
    NodeAssert.equal(
      (await runDeploy3Deadline({ env, nowMs: deadline + 1, fetchImpl: fixture.fetchImpl })).status,
      "not-due",
    );
    NodeAssert.equal(fixture.cf.present(), true);
    NodeAssert.equal(
      (await runDeploy3Deadline({ env, nowMs: extended + 1, fetchImpl: fixture.fetchImpl })).status,
      "receipt-unconfirmed",
    );
    NodeAssert.equal(fixture.cf.present(), false);
  },
);
