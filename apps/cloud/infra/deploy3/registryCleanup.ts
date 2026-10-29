import { cleanupDeploy3Bootstrap } from "./bootstrapCleanup.ts";
import type { Deploy3Bootstrap } from "./bootstrapRegistry.ts";
import { cleanupDeploy3WithScopedToken } from "./scopedCleanup.ts";
import { cleanupDeploy3Worker } from "./cloudflare.ts";
import type { Deploy3RegisteredControl } from "./controlRegistry.ts";
import type { Deploy3RegistryApi } from "./registryGitHub.ts";
import { deploy3PublicReceipt } from "./teardownReceipt.ts";
import { verifyDeploy3TokenExpiry } from "./tokenExpiry.ts";

export async function cleanupRegisteredDeploy3(input: {
  readonly state: Pick<
    Deploy3RegisteredControl,
    | "registration"
    | "registrationSha256"
    | "deadlineUtc"
    | "cleanupTokenExpiresOn"
    | "ownersNotReleased"
  >;
  readonly registry: Deploy3RegistryApi;
  readonly accountId: string;
  readonly cloudflareToken: string;
  readonly bootstrap?: Deploy3Bootstrap;
  readonly tokenVerificationMode: "self" | "account-record";
  readonly nowMs: number;
  readonly fetchImpl?: typeof fetch;
}) {
  const { state } = input;
  if (input.nowMs < Date.parse(state.deadlineUtc)) return { status: "not-due" };
  const cleanup =
    input.tokenVerificationMode === "self"
      ? await cleanupDeploy3WithScopedToken({
          registration: state.registration,
          deadlineUtc: state.deadlineUtc,
          cleanupTokenExpiresOn: state.cleanupTokenExpiresOn,
          accountId: input.accountId,
          token: input.cloudflareToken,
          nowMs: input.nowMs,
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        })
      : await cleanupDeploy3Worker({
          accountId: input.accountId,
          token: input.cloudflareToken,
          workerName: state.registration.workerName,
          expectedTag: state.registration.workerId,
          registeredDeadlineUtc: state.deadlineUtc,
          expectedNamespaceIds: state.registration.namespaceIds,
          nowMs: input.nowMs,
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        });
  const token = await verifyDeploy3TokenExpiry({
    accountId: input.accountId,
    authorityToken: input.cloudflareToken,
    tokenId: state.registration.cleanupTokenId,
    expectedExpiresOn: state.cleanupTokenExpiresOn,
    nowMs: input.nowMs,
    mode: input.tokenVerificationMode,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  const operator =
    input.tokenVerificationMode === "account-record" && input.bootstrap
      ? await verifyDeploy3TokenExpiry({
          accountId: input.accountId,
          authorityToken: input.cloudflareToken,
          tokenId: input.bootstrap.operatorTokenId,
          expectedExpiresOn: input.bootstrap.operatorTokenExpiresOn,
          nowMs: input.nowMs,
          mode: "account-record",
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        })
      : undefined;
  const tokenExpiry =
    operator?.status === "expired-verified" || input.tokenVerificationMode === "self"
      ? token.status
      : "unverified";
  const receipt = deploy3PublicReceipt({
    cleanup,
    ownersNotReleased: state.ownersNotReleased,
    tokenExpiry,
    tokenExpiresOn: token.expiresOn,
    registeredResources: state.registration,
  });
  try {
    await input.registry.postReceipt(state.registrationSha256, receipt);
  } catch {
    return {
      status: "receipt-unconfirmed",
      absenceVerified: cleanup.cleanClaim,
      tokenExpiry: token.status,
    };
  }
  return {
    status: cleanup.cleanClaim && tokenExpiry !== "unverified" ? "verified" : "unverified",
    receipt,
  };
}

/** Enumerate durable registrations as well as Workers, so self-deletion cannot erase pending receipts. */
export async function runRegisteredDeploy3Backstop(input: {
  readonly registry: Deploy3RegistryApi;
  readonly accountId: string;
  readonly cloudflareToken: string;
  readonly nowMs: number;
  readonly fetchImpl?: typeof fetch;
}) {
  const snapshot = await input.registry.read();
  const results = [];
  for (const state of snapshot.controls) {
    if (
      input.nowMs < Date.parse(state.deadlineUtc) ||
      input.registry.receiptIsFinal(snapshot.comments, state.registrationSha256)
    )
      continue;
    const bootstrap = snapshot.bootstraps.find(
      (row) =>
        row.runId === state.registration.runId && row.workerName === state.registration.workerName,
    );
    try {
      results.push(
        await cleanupRegisteredDeploy3({
          ...input,
          state,
          tokenVerificationMode: "account-record",
          ...(bootstrap ? { bootstrap } : {}),
        }),
      );
    } catch {
      results.push({ status: "unverified", runId: state.registration.runId });
    }
  }
  for (const bootstrap of snapshot.bootstraps) {
    if (snapshot.controls.some((row) => row.registration.runId === bootstrap.runId)) continue;
    try {
      results.push(await cleanupDeploy3Bootstrap({ ...input, bootstrap }));
    } catch {
      results.push({ status: "unverified", runId: bootstrap.runId });
    }
  }
  return {
    controls: snapshot.controls,
    bootstraps: snapshot.bootstraps,
    results,
    cleanClaim: results.every((row) => row.status === "verified" || row.status === "not-due"),
  };
}
