import type { Deploy3ControlRegistration, Deploy3RegisteredControl } from "./controlRegistry.ts";
import type { Deploy3RegistryApi } from "./registryGitHub.ts";
import type { Deploy3Owner } from "./teardownReceipt.ts";
import { controlDigest } from "./controlRegistry.ts";
import { deploy3Expiry, encodeDeploy3ExtensionJson, type Deploy3UploadReceipt } from "./expiry.ts";

export async function registerDeploy3Control(
  api: Deploy3RegistryApi,
  registration: Deploy3ControlRegistration,
) {
  const before = await api.read();
  const bootstrap = before.bootstraps.find(
    (row) => row.runId === registration.runId && row.workerName === registration.workerName,
  );
  if (
    !bootstrap ||
    bootstrap.owners.length !== registration.owners.length ||
    bootstrap.owners.some((owner) => !registration.owners.some((row) => row.owner === owner))
  ) {
    throw new Error("Deployment registration lacks its exact durable bootstrap");
  }
  if (before.controls.some((row) => row.registration.runId === registration.runId)) {
    throw new Error("Deployment run is already registered");
  }
  await api.append(registration);
  const after = await api.read();
  const state = after.controls.find((row) => row.registration.runId === registration.runId);
  if (!state) throw new Error("Deployment control was not durably registered");
  return state;
}

/** The normal operator invokes this only after its full local export verifier succeeds. */
export async function releaseDeploy3Owner(input: {
  readonly api: Deploy3RegistryApi;
  readonly runId: string;
  readonly owner: Deploy3Owner;
  readonly verifyLocalExportAndExplicitRelease: () => Promise<{
    readonly verifiedLocalExportSha256: string;
    readonly explicitReleaseSha256: string;
  }>;
}) {
  const state = (await input.api.read()).controls.find(
    (row) => row.registration.runId === input.runId,
  );
  if (!state || !state.registration.owners.some((row) => row.owner === input.owner)) {
    throw new Error("Owner does not belong to this registered deployment");
  }
  if (!state.ownersNotReleased.includes(input.owner)) return state;
  const verified = await input.verifyLocalExportAndExplicitRelease();
  await input.api.append({
    kind: "released",
    runId: input.runId,
    registrationSha256: state.registrationSha256,
    owner: input.owner,
    ...verified,
  });
  const updated = (await input.api.read()).controls.find(
    (row) => row.registration.runId === input.runId,
  );
  if (!updated || updated.ownersNotReleased.includes(input.owner))
    throw new Error("Owner release did not persist");
  return updated;
}

export function requireAllDeploy3OwnersReleased(state: Deploy3RegisteredControl) {
  if (state.ownersNotReleased.length !== 0)
    throw new Error("Normal teardown still needs an owner's verified export and explicit release");
  return state;
}

export async function extendDeploy3Control(input: {
  readonly api: Deploy3RegistryApi;
  readonly runId: string;
  readonly receipt: Deploy3UploadReceipt;
  readonly verifyExtendedToken: (expectedExpiresOn: string) => Promise<boolean>;
}) {
  const state = (await input.api.read()).controls.find(
    (row) => row.registration.runId === input.runId,
  );
  const expiry = deploy3Expiry(input.receipt);
  if (
    !state ||
    !input.receipt.extension ||
    state.registration.workerName !== input.receipt.workerName ||
    state.registration.workerId !== input.receipt.workerId ||
    state.registration.deployedAtUtc !== input.receipt.receivedAtUtc ||
    expiry.originalDeadlineUtc !== state.registration.deadlineUtc ||
    expiry.deadlineMs <= Date.parse(state.deadlineUtc)
  ) {
    throw new Error("Extension does not bind this deployment and written coordinator authority");
  }
  if (!(await input.verifyExtendedToken(expiry.tokenExpiresOn)))
    throw new Error("Extended credential expiry is unverified");
  const coordinatorAuthoritySha256 = await controlDigest(
    encodeDeploy3ExtensionJson(input.receipt.extension),
  );
  await input.api.append({
    kind: "extended",
    runId: input.runId,
    registrationSha256: state.registrationSha256,
    deadlineUtc: expiry.deadlineUtc,
    cleanupTokenExpiresOn: expiry.tokenExpiresOn,
    coordinatorAuthoritySha256,
  });
  const updated = (await input.api.read()).controls.find(
    (row) => row.registration.runId === input.runId,
  );
  if (
    !updated ||
    updated.deadlineUtc !== expiry.deadlineUtc ||
    updated.extensionAuthoritySha256 !== coordinatorAuthoritySha256
  ) {
    throw new Error("Written extension did not persist");
  }
  return updated;
}
