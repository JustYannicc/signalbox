import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { bootstrapRegistration, controlFixture } from "./control.fixture.ts";
import { requireDeploy3Bootstrap } from "./bootstrapRegistry.ts";
import { runRegisteredDeploy3Backstop } from "./registryCleanup.ts";

NodeTest.test(
  "an upload requires a durable bootstrap matching the actual expiring operator token",
  async () => {
    const fixture = controlFixture();
    const rows = (await fixture.api().read()).bootstraps;
    NodeAssert.throws(
      () => requireDeploy3Bootstrap([], bootstrapRegistration),
      /durable exact bootstrap/,
    );
    NodeAssert.doesNotThrow(() => requireDeploy3Bootstrap(rows, bootstrapRegistration));
    NodeAssert.throws(
      () =>
        requireDeploy3Bootstrap(rows, {
          ...bootstrapRegistration,
          operatorTokenId: "f".repeat(32),
        }),
      /durable exact bootstrap/,
    );
  },
);

NodeTest.test(
  "an interrupted bootstrap is deleted but cannot publish its final receipt until operator expiry verifies",
  async () => {
    const fixture = controlFixture();
    fixture.comments.splice(0);
    let authoritative = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      if (
        !authoritative &&
        String(input).endsWith(`/tokens/${bootstrapRegistration.operatorTokenId}`)
      ) {
        return Response.json({
          success: true,
          result: { id: bootstrapRegistration.operatorTokenId, status: "expired" },
        });
      }
      return fixture.fetchImpl(input, init);
    };
    const api = (await import("./registryGitHub.ts")).deploy3RegistryApi({
      token: async () => "fresh-ci",
      trustedWriterIds: [101, 102],
      fetchImpl,
    });
    const input = {
      registry: api,
      accountId: fixture.env.DEPLOY3_ACCOUNT_ID,
      cloudflareToken: "existing-ci",
      nowMs: Date.parse("2026-10-31T12:00:00.000Z"),
      fetchImpl,
    };
    NodeAssert.equal((await runRegisteredDeploy3Backstop(input)).cleanClaim, false);
    NodeAssert.equal(fixture.cf.present(), false);
    NodeAssert.equal(fixture.comments.length, 0);
    authoritative = true;
    NodeAssert.equal((await runRegisteredDeploy3Backstop(input)).cleanClaim, true);
    NodeAssert.equal(fixture.comments.length, 1);
    NodeAssert.match(fixture.comments[0]!.body, /Token expiry: expired-verified/);
    NodeAssert.match(fixture.comments[0]!.body, /Worker .* absent/);
    NodeAssert.match(fixture.comments[0]!.body, /evidence not exported$/);
  },
);
