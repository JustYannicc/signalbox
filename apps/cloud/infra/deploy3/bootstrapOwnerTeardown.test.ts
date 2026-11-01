import { expect, it } from "vite-plus/test";
import { bootstrapRegistration, controlFixture } from "./control.fixture.ts";
import { isoAt } from "./platform.ts";
import { finalizeDeploy3OwnerTeardown } from "./ownerTeardownLifecycle.ts";
import { absentFixture, finalizationInput, nowMs } from "./ownerTeardown.fixture.ts";
import { runRegisteredDeploy3Backstop } from "./registryCleanup.ts";

it("closes an absent bootstrap-only run without treating a revoked operator token as expired", async () => {
  const f = await absentFixture();
  f.comments.splice(0);
  f.cf.calls.length = 0;
  const input = finalizationInput(f, async (request, init) => {
    if (String(request).includes("/tokens/")) throw new Error("Revoked token has no expiry proof");
    return f.fetchImpl(request, init);
  });
  expect((await input.api.read()).controls).toEqual([]);
  expect((await finalizeDeploy3OwnerTeardown(input)).status).toBe("verified");
  const proof = f.comments[0]!;
  expect(proof.body).not.toContain("expired-verified");
  expect(f.cf.calls.every((call) => call.startsWith("GET "))).toBe(true);
  const swept = await runRegisteredDeploy3Backstop({ ...input, registry: input.api });
  expect(swept.cleanClaim).toBe(true);
  expect(swept.results).toEqual([{ status: "not-due", runId: bootstrapRegistration.runId }]);
  expect((await input.api.read()).bootstraps).toEqual([bootstrapRegistration]);
});

it("keeps an unresolved bootstrap failure red for the whole sweep", async () => {
  const f = await absentFixture();
  f.comments.splice(0);
  const input = finalizationInput(f, async (request, init) =>
    String(request).includes("/tokens/")
      ? Response.json({}, { status: 403 })
      : f.fetchImpl(request, init),
  );
  const swept = await runRegisteredDeploy3Backstop({ ...input, registry: input.api, nowMs });
  expect(swept.cleanClaim).toBe(false);
  expect(swept.results).toEqual([{ status: "unverified", runId: bootstrapRegistration.runId }]);
  expect(f.comments).toEqual([]);
});

it.each([
  "untrusted-writer",
  "other-trusted-writer",
  "old-comment",
  "digest",
  "run",
  "worker",
  "token",
  "future",
  "before-start",
  "malformed",
  "noncanonical",
  "extra-field",
])("rejects a %s bootstrap closeout", async (mismatch) => {
  const f = await absentFixture();
  f.comments.splice(0);
  const input = finalizationInput(f);
  expect((await finalizeDeploy3OwnerTeardown(input)).status).toBe("verified");
  const proof = f.comments[0]!;
  let body = proof.body;
  switch (mismatch) {
    case "digest": {
      const digest = body.match(/"bootstrapSha256":"([a-f0-9]{64})"/)![1]!;
      body = body.replace(digest, "0".repeat(64));
      break;
    }
    case "run":
      body = body.replace('"runId":"deadbeef"', '"runId":"feedface"');
      break;
    case "worker":
      body = body.replace(
        bootstrapRegistration.workerName,
        bootstrapRegistration.workerName.replace("deadbeef", "feedface"),
      );
      break;
    case "token":
      body = body.replace(bootstrapRegistration.operatorTokenId, "0".repeat(32));
      break;
    case "future":
      body = body.replace(isoAt(nowMs), isoAt(nowMs + 1));
      break;
    case "before-start":
      body = body.replace(isoAt(nowMs), "2026-10-29T11:00:00.000Z");
      break;
    case "malformed":
      body += "}";
      break;
    case "noncanonical":
      body += "\n";
      break;
    case "extra-field":
      body = body.replace('{"schema"', '{"extra":true,"schema"');
      break;
  }
  f.comments[0] = {
    ...proof,
    body,
    id: mismatch === "old-comment" ? 99 : proof.id,
    user: {
      id: mismatch === "untrusted-writer" ? 999 : mismatch === "other-trusted-writer" ? 102 : 101,
    },
  };
  expect(
    await input.api.bootstrapTeardownIsFinal(
      (await input.api.read()).comments,
      bootstrapRegistration,
      nowMs,
    ),
  ).toBe(false);
  const fetchImpl: typeof fetch = async (request, init) =>
    String(request).includes("/tokens/")
      ? Response.json({}, { status: 403 })
      : f.fetchImpl(request, init);
  const sweepInput = finalizationInput(f, fetchImpl);
  expect(
    (await runRegisteredDeploy3Backstop({ ...sweepInput, registry: sweepInput.api })).cleanClaim,
  ).toBe(false);
});

it.each(["worker", "namespace-owner", "tail", "incomplete-inventory", "failed-write"])(
  "does not close a bootstrap when %s prevents verified absence",
  async (obstacle) => {
    const f = obstacle === "worker" ? controlFixture() : await absentFixture();
    f.comments.splice(0);
    const fetchImpl: typeof fetch = async (request, init) => {
      const url = new URL(String(request));
      if (url.pathname.endsWith("/namespaces") && obstacle === "namespace-owner")
        return Response.json({
          success: true,
          result: [{ id: "leftover-namespace", script: bootstrapRegistration.workerName }],
        });
      if (url.pathname.endsWith("/tails") && obstacle === "tail")
        return Response.json({ success: true, result: { id: "leftover-tail" } });
      if (url.pathname.endsWith("/scripts") && obstacle === "incomplete-inventory")
        return Response.json({ success: true, result: {} });
      if (
        url.hostname === "api.github.com" &&
        init?.method === "POST" &&
        obstacle === "failed-write"
      )
        return Response.json({}, { status: 503 });
      return f.fetchImpl(request, init);
    };
    expect((await finalizeDeploy3OwnerTeardown(finalizationInput(f, fetchImpl))).status).toBe(
      "unconfirmed",
    );
    expect(f.comments).toEqual([]);
  },
);

it("recovers an uncertain bootstrap proof readback without duplicate publication", async () => {
  const f = await absentFixture();
  f.comments.splice(0);
  let failed = false;
  const fetchImpl: typeof fetch = async (request, init) => {
    if (String(request).includes("/issues/comments/") && !failed) {
      failed = true;
      return Response.json({}, { status: 503 });
    }
    return f.fetchImpl(request, init);
  };
  expect((await finalizeDeploy3OwnerTeardown(finalizationInput(f, fetchImpl))).status).toBe(
    "unconfirmed",
  );
  expect(f.comments).toHaveLength(1);
  f.cf.calls.length = 0;
  expect((await finalizeDeploy3OwnerTeardown(finalizationInput(f))).status).toBe("verified");
  expect(f.comments).toHaveLength(1);
  expect(f.cf.calls).toEqual([]);
});

it.each([undefined, "", null])(
  "keeps namespace ownership %s from producing a clean bootstrap closeout",
  async (owner) => {
    const f = await absentFixture();
    f.comments.splice(0);
    const fetchImpl: typeof fetch = async (request, init) => {
      if (new URL(String(request)).pathname.endsWith("/namespaces"))
        return Response.json({
          success: true,
          result: [{ id: "leftover-namespace", script: owner }],
        });
      if (String(request).includes("/tokens/")) return Response.json({}, { status: 403 });
      return f.fetchImpl(request, init);
    };
    const input = finalizationInput(f, fetchImpl);
    expect((await finalizeDeploy3OwnerTeardown(input)).status).toBe("unconfirmed");
    expect(f.comments).toEqual([]);
    const sweep = await runRegisteredDeploy3Backstop({ ...input, registry: input.api });
    expect(sweep.cleanClaim).toBe(false);
    expect(sweep.results).toEqual([{ status: "unverified", runId: bootstrapRegistration.runId }]);
  },
);

it("does not use a bootstrap closeout to skip a later full registration", async () => {
  const f = await absentFixture();
  const registration = f.comments[0]!;
  f.comments.splice(0);
  expect((await finalizeDeploy3OwnerTeardown(finalizationInput(f))).status).toBe("verified");
  f.comments.push({ ...registration, id: f.comments[0]!.id + 1 });
  const input = finalizationInput(f, async (request, init) =>
    String(request).includes("/tokens/")
      ? Response.json({}, { status: 403 })
      : f.fetchImpl(request, init),
  );
  expect((await runRegisteredDeploy3Backstop({ ...input, registry: input.api })).cleanClaim).toBe(
    false,
  );
});
