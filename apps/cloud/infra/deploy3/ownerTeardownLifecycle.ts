import { listDeploy3Namespaces, listDeploy3Tails, namespaceOwner } from "./cloudflareApi.ts";
import { createDeploy3CloudflareApi } from "./cloudflareTransport.ts";
import { listDeploy3WorkerInventory } from "./cloudflare.ts";
import { controlDigest } from "./controlRegistry.ts";
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
    if (!state || !Number.isSafeInteger(input.nowMs))
      return { ...result, status: "unconfirmed" as const };
    if (input.api.ownerTeardownIsFinal(snapshot.comments, state, input.nowMs))
      return { ...result, status: "verified" as const };
    const options = {
      accountId: input.accountId,
      token: input.cloudflareToken,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    };
    const api = createDeploy3CloudflareApi(options);
    const [workers, namespaces, tails] = await Promise.all([
      listDeploy3WorkerInventory(options),
      listDeploy3Namespaces(api),
      listDeploy3Tails(api, state.registration.workerName),
    ]);
    if (
      workers.some((row) => row.id === state.registration.workerName) ||
      tails.length ||
      namespaces.some(
        (row) =>
          namespaceOwner(row) === state.registration.workerName ||
          state.registration.namespaceIds.includes(String(row.id)),
      )
    )
      return { ...result, status: "unconfirmed" as const };
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
