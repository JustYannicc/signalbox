import { listDeploy3Namespaces, listDeploy3Tails, namespaceOwner } from "./cloudflareApi.ts";
import { createDeploy3CloudflareApi } from "./cloudflareTransport.ts";
import { listDeploy3WorkerInventory } from "./cloudflare.ts";
import { controlDigest } from "./controlRegistry.ts";
import { bootstrapBody } from "./bootstrapRegistry.ts";
import { bootstrapTeardownBody } from "./bootstrapOwnerTeardown.ts";
import { ownerTeardownBody } from "./ownerTeardown.ts";
import { isoAt } from "./platform.ts";
import type { Deploy3RegistryApi } from "./registryGitHub.ts";

/** Read-only resource verification also closes older owner-deleted runs without rewriting their receipts. */
export async function finalizeDeploy3OwnerTeardown(input: {
  readonly api: Deploy3RegistryApi;
  readonly runId: string;
  readonly accountId: string;
  readonly cloudflareToken: string;
  readonly nowMs: number;
  readonly fetchImpl?: typeof fetch;
}) {
  const result = { runId: input.runId };
  try {
    const snapshot = await input.api.read();
    const state = snapshot.controls.find((row) => row.registration.runId === input.runId);
    const bootstrap = snapshot.bootstraps.find((row) => row.runId === input.runId);
    const identity = state?.registration ?? bootstrap;
    if (!identity || !Number.isSafeInteger(input.nowMs))
      return { ...result, status: "unconfirmed" as const };
    if (
      state
        ? input.api.ownerTeardownIsFinal(snapshot.comments, state, input.nowMs)
        : bootstrap &&
          (await input.api.bootstrapTeardownIsFinal(snapshot.comments, bootstrap, input.nowMs))
    )
      return { ...result, status: "verified" as const };
    const workerName = identity.workerName;
    const options = {
      accountId: input.accountId,
      token: input.cloudflareToken,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    };
    const api = createDeploy3CloudflareApi(options);
    const [workers, namespaces, tails] = await Promise.all([
      listDeploy3WorkerInventory(options),
      listDeploy3Namespaces(api),
      listDeploy3Tails(api, workerName),
    ]);
    if (
      workers.some((row) => row.id === workerName) ||
      tails.length ||
      namespaces.some(
        (row) =>
          namespaceOwner(row) === workerName ||
          state?.registration.namespaceIds.includes(String(row.id)),
      )
    )
      return { ...result, status: "unconfirmed" as const };
    if (!state && bootstrap) {
      const proof = {
        schema: "sb1070/deploy3-bootstrap-teardown/v1" as const,
        runId: bootstrap.runId,
        bootstrapSha256: await controlDigest(bootstrapBody(bootstrap)),
        workerName,
        operatorTokenId: bootstrap.operatorTokenId,
        verifiedAtUtc: isoAt(input.nowMs),
        absenceVerified: true as const,
        verificationSha256: await controlDigest(JSON.stringify({ workers, namespaces, tails })),
      };
      bootstrapTeardownBody(proof);
      await input.api.postBootstrapTeardown(proof);
      const after = await input.api.read();
      return {
        ...result,
        status: (await input.api.bootstrapTeardownIsFinal(after.comments, bootstrap, input.nowMs))
          ? ("verified" as const)
          : ("unconfirmed" as const),
      };
    }
    if (!state) return { ...result, status: "unconfirmed" as const };
    const proof = {
      schema: "sb1070/deploy3-owner-teardown/v1" as const,
      runId: input.runId,
      registrationSha256: state.registrationSha256,
      workerName: state.registration.workerName,
      workerId: state.registration.workerId,
      namespaceIds: state.registration.namespaceIds,
      tailIds: state.registration.tailIds,
      verifiedAtUtc: isoAt(input.nowMs),
      absenceVerified: true as const,
      verificationSha256: await controlDigest(JSON.stringify({ workers, namespaces, tails })),
    };
    ownerTeardownBody(proof);
    await input.api.postOwnerTeardown(proof);
    const after = await input.api.read();
    return {
      ...result,
      status: input.api.ownerTeardownIsFinal(after.comments, state, input.nowMs)
        ? ("verified" as const)
        : ("unconfirmed" as const),
    };
  } catch {
    return { ...result, status: "unconfirmed" as const };
  }
}
