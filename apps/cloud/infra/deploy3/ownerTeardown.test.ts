import { expect, it } from "vite-plus/test";
import { controlFixture, controlRegistration } from "./control.fixture.ts";
import { releaseDeploy3Owner } from "./controlLifecycle.ts";
import { cleanupReleasedDeploy3 } from "./normalOperator.ts";
import { runRegisteredDeploy3Backstop } from "./registryCleanup.ts";
import { OWNER_TEARDOWN_MARKER } from "./ownerTeardown.ts";
import { finalizeDeploy3OwnerTeardown } from "./ownerTeardownLifecycle.ts";
import { absentFixture, finalizationInput } from "./ownerTeardown.fixture.ts";

async function releasedFixture() {
  const f = controlFixture();
  for (const owner of ["1070", "1255"] as const)
    await releaseDeploy3Owner({
      api: f.api(`owner${owner}`),
      runId: controlRegistration.runId,
      owner,
      verifyLocalExportAndExplicitRelease: async () => ({
        verifiedLocalExportSha256: "e".repeat(64),
        explicitReleaseSha256: "f".repeat(64),
      }),
    });
  return f;
}

it("closes an owner's verified teardown so revoked credentials cannot make later sweeps fail", async () => {
  const f = await releasedFixture();
  const deadline = Date.parse(controlRegistration.deadlineUtc);
  const cleanup = await cleanupReleasedDeploy3({
    api: f.api(),
    runId: controlRegistration.runId,
    accountId: f.env.DEPLOY3_ACCOUNT_ID,
    cloudflareToken: "offline-test-token",
    nowMs: deadline - 1_000,
    fetchImpl: f.fetchImpl,
  });
  expect(cleanup.cleanClaim).toBe(true);
  let tokenReads = 0;
  const later = await runRegisteredDeploy3Backstop({
    registry: f.api(),
    accountId: f.env.DEPLOY3_ACCOUNT_ID,
    cloudflareToken: "offline-test-token",
    nowMs: deadline + 60_000,
    fetchImpl: async (input, init) => {
      if (String(input).includes("/tokens/")) {
        tokenReads++;
        return Response.json({}, { status: 403 });
      }
      return f.fetchImpl(input, init);
    },
  });
  expect(later.cleanClaim).toBe(true);
  expect(later.results).toEqual([]);
  expect(tokenReads).toBe(0);
});

it("keeps the failing run id when a registered cleanup cannot verify credential expiry", async () => {
  const f = controlFixture();
  const result = await runRegisteredDeploy3Backstop({
    registry: f.api(),
    accountId: f.env.DEPLOY3_ACCOUNT_ID,
    cloudflareToken: "offline-test-token",
    nowMs: Date.parse(controlRegistration.deadlineUtc) + 60_000,
    fetchImpl: async (input, init) =>
      String(input).includes("/tokens/")
        ? Response.json({}, { status: 403 })
        : f.fetchImpl(input, init),
  });
  expect(result.cleanClaim).toBe(false);
  expect(result.results).toContainEqual(
    expect.objectContaining({ status: "unverified", runId: controlRegistration.runId }),
  );
});

it("closes an older absent run without changing held owners or reading revoked tokens", async () => {
  const f = await absentFixture();
  const original = [...f.comments];
  f.cf.calls.length = 0;
  const result = await finalizeDeploy3OwnerTeardown(finalizationInput(f));
  expect(result.status).toBe("verified");
  expect(f.comments.slice(0, original.length)).toEqual(original);
  expect((await f.api().read()).controls[0]?.ownersNotReleased).toEqual(["1070", "1255"]);
  expect(f.cf.calls.every((call) => call.startsWith("GET "))).toBe(true);
  const later = await runRegisteredDeploy3Backstop({
    ...finalizationInput(f, async (input, init) => {
      if (String(input).includes("/tokens/")) throw new Error("Revoked token must not be read");
      return f.fetchImpl(input, init);
    }),
    registry: f.api(),
  });
  expect(later.cleanClaim).toBe(true);
  expect(later.results).toEqual([]);
});

it.each(["worker", "namespace-id", "namespace-owner", "tail", "incomplete-inventory"])(
  "does not finalize when %s prevents verified absence",
  async (obstacle) => {
    const f = obstacle === "worker" ? controlFixture() : await absentFixture();
    f.cf.calls.length = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/namespaces") && obstacle.startsWith("namespace"))
        return Response.json({
          success: true,
          result: [
            {
              id: obstacle === "namespace-id" ? "owned-namespace" : "unexpected-namespace",
              script:
                obstacle === "namespace-owner" ? controlRegistration.workerName : "other-worker",
            },
          ],
        });
      if (path.endsWith("/tails") && obstacle === "tail")
        return Response.json({ success: true, result: { id: "owned-tail" } });
      if (path.endsWith("/scripts") && obstacle === "incomplete-inventory")
        return Response.json({ success: true, result: {} });
      return f.fetchImpl(input, init);
    };
    expect((await finalizeDeploy3OwnerTeardown(finalizationInput(f, fetchImpl))).status).toBe(
      "unconfirmed",
    );
    expect(f.comments).toHaveLength(1);
    expect(f.cf.calls.every((call) => call.startsWith("GET "))).toBe(true);
  },
);

it("does not report normal cleanup complete when the registry write fails", async () => {
  const f = await releasedFixture();
  const fetchImpl: typeof fetch = async (input, init) =>
    new URL(String(input)).hostname === "api.github.com" && init?.method === "POST"
      ? Response.json({}, { status: 503 })
      : f.fetchImpl(input, init);
  const input = finalizationInput(f, fetchImpl);
  const result = await cleanupReleasedDeploy3(input);
  expect(result.cleanClaim).toBe(true);
  expect(result.registryFinalization).toBe("unconfirmed");
  expect(f.comments.filter((row) => row.body.startsWith(OWNER_TEARDOWN_MARKER))).toEqual([]);
});

it("recovers a published proof after failed readback without posting it again", async () => {
  const f = await absentFixture();
  let failed = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    if (new URL(String(input)).pathname.includes("/issues/comments/") && !failed) {
      failed = true;
      return Response.json({}, { status: 503 });
    }
    return f.fetchImpl(input, init);
  };
  expect((await finalizeDeploy3OwnerTeardown(finalizationInput(f, fetchImpl))).status).toBe(
    "unconfirmed",
  );
  expect(f.comments).toHaveLength(2);
  f.cf.calls.length = 0;
  expect((await finalizeDeploy3OwnerTeardown(finalizationInput(f))).status).toBe("verified");
  expect(f.comments).toHaveLength(2);
  expect(f.cf.calls).toEqual([]);
});
