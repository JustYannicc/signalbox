import { expect, it } from "vite-plus/test";
import { controlRegistration } from "./control.fixture.ts";
import { OWNER_TEARDOWN_MARKER } from "./ownerTeardown.ts";
import { finalizeDeploy3OwnerTeardown } from "./ownerTeardownLifecycle.ts";
import { runRegisteredDeploy3Backstop } from "./registryCleanup.ts";
import { absentFixture, finalizationInput, nowMs } from "./ownerTeardown.fixture.ts";
import { isoAt } from "./platform.ts";

it.each([
  "untrusted-writer",
  "other-trusted-writer",
  "old-comment",
  "registration",
  "run",
  "worker-id",
  "worker-name",
  "namespace",
  "tail",
  "future",
  "before-deploy",
  "malformed",
  "noncanonical",
  "extra-field",
])("keeps a %s proof from suppressing a registered sweep", async (mismatch) => {
  const f = await absentFixture();
  expect((await finalizeDeploy3OwnerTeardown(finalizationInput(f))).status).toBe("verified");
  const index = f.comments.findIndex((row) => row.body.startsWith(OWNER_TEARDOWN_MARKER));
  const proof = f.comments[index]!;
  const state = (await f.api().read()).controls[0]!;
  expect(f.api().ownerTeardownIsFinal(f.comments, state, nowMs)).toBe(true);
  let body = proof.body;
  switch (mismatch) {
    case "registration":
      body = body.replace(state.registrationSha256, "0".repeat(64));
      break;
    case "run":
      body = body.replace('"runId":"deadbeef"', '"runId":"feedface"');
      break;
    case "worker-id":
      body = body.replace(controlRegistration.workerId, "0".repeat(32));
      break;
    case "worker-name":
      body = body.replace(
        controlRegistration.workerName,
        controlRegistration.workerName.replace("deadbeef", "feedface"),
      );
      break;
    case "namespace":
      body = body.replace("owned-namespace", "other-namespace");
      break;
    case "tail":
      body = body.replace("owned-tail", "other-tail");
      break;
    case "future":
      body = body.replace(isoAt(nowMs), isoAt(nowMs + 1));
      break;
    case "before-deploy":
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
  f.comments[index] = {
    ...proof,
    user: {
      id: mismatch === "untrusted-writer" ? 999 : mismatch === "other-trusted-writer" ? 102 : 101,
    },
    body,
  };
  if (mismatch === "old-comment") f.comments[0] = { ...f.comments[0]!, id: proof.id + 1 };
  const changedState = (await f.api().read()).controls[0]!;
  expect(f.api().ownerTeardownIsFinal(f.comments, changedState, nowMs)).toBe(false);
  const result = await runRegisteredDeploy3Backstop({
    ...finalizationInput(f, async (input, init) =>
      String(input).includes("/tokens/")
        ? Response.json({}, { status: 403 })
        : f.fetchImpl(input, init),
    ),
    registry: f.api(),
  });
  expect(result.cleanClaim).toBe(false);
  expect(result.results).toContainEqual(
    expect.objectContaining({ runId: controlRegistration.runId, status: "unverified" }),
  );
});
