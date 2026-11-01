import { expect } from "vite-plus/test";
import { controlFixture, controlRegistration } from "./control.fixture.ts";
import { cleanupDeploy3Worker } from "./cloudflare.ts";
import { deploy3RegistryApi } from "./registryGitHub.ts";

export const nowMs = Date.parse(controlRegistration.deadlineUtc) + 60_000;

export function finalizationInput(f: ReturnType<typeof controlFixture>, fetchImpl = f.fetchImpl) {
  return {
    api: deploy3RegistryApi({
      token: async () => "owner1070",
      trustedWriterIds: [101, 102],
      fetchImpl,
    }),
    runId: controlRegistration.runId,
    accountId: f.env.DEPLOY3_ACCOUNT_ID,
    cloudflareToken: "offline-test-token",
    nowMs,
    fetchImpl,
  };
}

export async function absentFixture() {
  const f = controlFixture();
  const cleanup = await cleanupDeploy3Worker({
    accountId: f.env.DEPLOY3_ACCOUNT_ID,
    token: "offline-test-token",
    workerName: controlRegistration.workerName,
    expectedTag: controlRegistration.workerId,
    expectedNamespaceIds: controlRegistration.namespaceIds,
    nowMs,
    fetchImpl: f.fetchImpl,
  });
  expect(cleanup.cleanClaim).toBe(true);
  return f;
}
