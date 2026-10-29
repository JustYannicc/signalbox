import { cleanupDeploy3Worker } from "./cloudflare.ts";
import { bootstrapBody, type Deploy3Bootstrap } from "./bootstrapRegistry.ts";
import { controlDigest } from "./controlRegistry.ts";
import { parseDeploy3Name } from "./deadline.ts";
import type { Deploy3RegistryApi } from "./registryGitHub.ts";
import { deploy3PublicReceipt } from "./teardownReceipt.ts";
import { verifyDeploy3TokenExpiry } from "./tokenExpiry.ts";

export async function cleanupDeploy3Bootstrap(input: {
  readonly bootstrap: Deploy3Bootstrap;
  readonly registry: Deploy3RegistryApi;
  readonly accountId: string;
  readonly cloudflareToken: string;
  readonly nowMs: number;
  readonly fetchImpl?: typeof fetch;
}) {
  const row = input.bootstrap;
  const parsed = parseDeploy3Name(row.workerName);
  if (!parsed) throw new Error("Bootstrap deadline identity is invalid");
  const sha256 = await controlDigest(bootstrapBody(row));
  if (
    input.nowMs < parsed.deadlineMs ||
    input.registry.receiptIsFinal(await input.registry.comments(), sha256)
  )
    return { status: "not-due" };
  const cleanup = await cleanupDeploy3Worker({
    accountId: input.accountId,
    token: input.cloudflareToken,
    workerName: row.workerName,
    nowMs: input.nowMs,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  const expiry = await verifyDeploy3TokenExpiry({
    accountId: input.accountId,
    authorityToken: input.cloudflareToken,
    tokenId: row.operatorTokenId,
    expectedExpiresOn: row.operatorTokenExpiresOn,
    nowMs: input.nowMs,
    mode: "account-record",
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  // Preserve the durable bootstrap and revisit it until both facts are authoritative.
  if (!cleanup.cleanClaim || expiry.status !== "expired-verified") return { status: "unverified" };
  await input.registry.postReceipt(
    sha256,
    deploy3PublicReceipt({
      cleanup,
      ownersNotReleased: row.owners,
      tokenExpiry: expiry.status,
      tokenExpiresOn: expiry.expiresOn,
      registeredResources: { namespaceIds: [], tailIds: [] },
    }),
  );
  return { status: "verified" };
}
